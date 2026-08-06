import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import {
  ContactSegmentDocument,
  ContactSegmentSchemaClass,
} from './contact-segment.schema';
import {
  CreateContactSegmentDto,
  UpdateContactSegmentDto,
} from './dto/contact-segment.dto';
import { FilterGroup, compileContactFilter } from '../filters/contact-filter';
import { CustomFieldsService } from '../../custom-fields/custom-fields.service';

export interface SegmentSummary {
  id: string;
  name: string;
  description?: string;
  type: 'dynamic' | 'static';
  filter?: FilterGroup;
  memberCount?: number;
  updatedAt: Date;
}

@Injectable()
export class ContactSegmentsService {
  constructor(
    @InjectModel(ContactSegmentSchemaClass.name)
    private readonly model: Model<ContactSegmentDocument>,
    private readonly customFields: CustomFieldsService,
    private readonly cls: ClsService,
  ) {}

  async list(): Promise<SegmentSummary[]> {
    const docs = await this.model
      .find()
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean()
      .exec();
    return docs.map((doc) => this.toSummary(doc));
  }

  async findById(id: string): Promise<ContactSegmentDocument> {
    const doc = await this.model.findOne({ _id: id }).exec();
    if (!doc) throw new NotFoundException(`Segment ${id} not found`);
    return doc;
  }

  async create(dto: CreateContactSegmentDto): Promise<SegmentSummary> {
    await this.assertDefinitionIsUsable(dto.type, dto.filter);
    const userId = this.requireUserId();

    const created = await this.model.create({
      name: dto.name.trim(),
      description: dto.description?.trim(),
      type: dto.type,
      filter: dto.type === 'dynamic' ? dto.filter : undefined,
      memberIds: dto.type === 'static' ? (dto.memberIds ?? []) : [],
      tenantId: this.requireTenantId(),
      createdById: userId,
      updatedById: userId,
    });

    return this.toSummary(created.toObject());
  }

  async update(
    id: string,
    dto: UpdateContactSegmentDto,
  ): Promise<SegmentSummary> {
    const existing = await this.findById(id);
    const type = dto.type ?? existing.type;
    const filter = dto.filter ?? (existing.filter as FilterGroup | undefined);
    await this.assertDefinitionIsUsable(type, filter);

    existing.set({
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.description !== undefined
        ? { description: dto.description.trim() }
        : {}),
      type,
      // Switching kinds clears the other kind's definition, so a segment can
      // never carry a stale filter that nothing evaluates or a member list that
      // nothing reads — either would resurface on the next type change.
      filter: type === 'dynamic' ? filter : undefined,
      memberIds: type === 'static' ? (dto.memberIds ?? existing.memberIds) : [],
      updatedById: this.requireUserId(),
    });
    await existing.save();

    return this.toSummary(existing.toObject());
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.model.findOneAndDelete({ _id: id }).exec();
    if (!deleted) throw new NotFoundException(`Segment ${id} not found`);
  }

  /**
   * The Mongo predicate for a segment's membership.
   *
   * Returned as a filter rather than a list of ids so the caller composes it
   * with its own scope and pagination — materialising a million-member dynamic
   * segment to filter a 25-row page is the mistake this shape prevents.
   */
  async buildMembershipFilter(id: string): Promise<FilterQuery<any>> {
    const segment = await this.findById(id);

    if (segment.type === 'static') {
      return {
        _id: {
          $in: (segment.memberIds ?? []).map(
            (memberId) => new Types.ObjectId(String(memberId)),
          ),
        },
      };
    }

    const compiled = compileContactFilter(
      segment.filter as FilterGroup,
      await this.customFieldKeys(),
    );
    // A dynamic segment whose conditions all compiled away matches nothing. That
    // is the honest answer: the alternative — an empty predicate — would silently
    // select EVERY contact in the tenant, which is how a campaign goes to the
    // whole database.
    return compiled ?? { _id: { $in: [] } };
  }

  /** Compile an unsaved definition, so the builder can show a count as you type. */
  async compileDraft(filter: FilterGroup): Promise<FilterQuery<any>> {
    const compiled = compileContactFilter(filter, await this.customFieldKeys());
    return compiled ?? { _id: { $in: [] } };
  }

  private async assertDefinitionIsUsable(
    type: string,
    filter?: FilterGroup,
  ): Promise<void> {
    if (type !== 'dynamic') return;
    if (
      !filter ||
      !Array.isArray(filter.conditions) ||
      !filter.conditions.length
    ) {
      throw new BadRequestException(
        'A dynamic segment needs at least one condition.',
      );
    }
    // Compile now, so an invalid field or operator is rejected at save time
    // rather than at send time.
    compileContactFilter(filter, await this.customFieldKeys());
  }

  private async customFieldKeys(): Promise<ReadonlySet<string>> {
    const fields = await this.customFields.getByModule('Contact');
    return new Set(fields.map((field) => field.internalKey));
  }

  private toSummary(doc: Record<string, any>): SegmentSummary {
    return {
      id: String(doc._id),
      name: doc.name,
      description: doc.description,
      type: doc.type,
      filter: doc.filter,
      memberCount:
        doc.type === 'static' ? (doc.memberIds?.length ?? 0) : undefined,
      updatedAt: doc.updatedAt,
    };
  }

  private requireTenantId(): string {
    const tenantId =
      this.cls.get<string>('activeTenantId') ??
      this.cls.get<string>('tenantId');
    if (!tenantId) throw new BadRequestException('Tenant context is required.');
    return tenantId;
  }

  private requireUserId(): string {
    const userId =
      this.cls.get<string>('userId') ?? this.cls.get<string>('user.id');
    if (!userId) throw new BadRequestException('User context is required.');
    return userId;
  }
}
