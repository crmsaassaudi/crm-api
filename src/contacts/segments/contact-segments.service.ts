import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
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
import {
  FilterFieldDescriptor,
  FilterGroup,
  compileContactFilter,
  describeFilterFields,
} from '../filters/contact-filter';
import { ContactSchemaClass } from '../infrastructure/persistence/document/entities/contact.schema';
import {
  CampaignSchemaClass,
  EDITABLE_CAMPAIGN_STATUSES,
} from '../../campaigns/campaign.schema';
import { CustomFieldsService } from '../../custom-fields/custom-fields.service';

export interface SegmentSummary {
  id: string;
  name: string;
  description?: string;
  type: 'dynamic' | 'static';
  filter?: FilterGroup;
  memberCount?: number;
  /** Tenant-wide match count from the last save; null when it timed out. */
  cachedCount?: number | null;
  countedAt?: Date | null;
  updatedAt: Date;
}

/**
 * How long a segment size may take before the save stops waiting for it.
 *
 * A definition with a `contains` condition scans the collection, and a save that
 * blocks for twenty seconds to produce a number nobody asked for is worse than
 * having no number. The segment is stored either way.
 */
const COUNT_TIMEOUT_MS = 3_000;

@Injectable()
export class ContactSegmentsService {
  private readonly logger = new Logger(ContactSegmentsService.name);

  constructor(
    @InjectModel(ContactSegmentSchemaClass.name)
    private readonly model: Model<ContactSegmentDocument>,
    @InjectModel(ContactSchemaClass.name)
    private readonly contacts: Model<ContactSchemaClass>,
    @InjectModel(CampaignSchemaClass.name)
    private readonly campaigns: Model<CampaignSchemaClass>,
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

  /**
   * The fields a client may filter on, and which operators each accepts.
   *
   * Served rather than hard-coded in the browser: a copy of this list in the
   * frontend goes stale the moment a field is added or a tenant defines a custom
   * one, and the symptom is a filter the server refuses for reasons the person
   * building it cannot see.
   */
  async filterFields(): Promise<FilterFieldDescriptor[]> {
    return describeFilterFields([...(await this.customFieldKeys())]);
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

    await this.refreshCount(created);
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

    await this.refreshCount(existing);
    return this.toSummary(existing.toObject());
  }

  /**
   * Delete, unless something is still counting on it.
   *
   * A campaign holds an audience by reference until it launches, at which point
   * the run freezes its own predicate and stops caring. So the block covers
   * exactly the window where deleting would break something: a draft whose
   * audience would silently become unresolvable, and a scheduled campaign that
   * would fail in a worker at 3am with nobody watching.
   */
  async remove(id: string): Promise<void> {
    const blocking = await this.campaigns
      .find({
        deletedAt: null,
        status: { $in: [...EDITABLE_CAMPAIGN_STATUSES] },
        $or: [
          { 'audience.include.segmentId': id },
          { 'audience.exclude.segmentId': id },
        ],
      })
      .select({ name: 1 })
      .limit(3)
      .lean()
      .exec();

    if (blocking.length) {
      const names = blocking.map((doc) => doc.name).join(', ');
      throw new ConflictException(
        `This segment is the audience of ${names}. Change or delete those campaigns first.`,
      );
    }

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
    return this.membershipFilterOf(await this.findById(id));
  }

  private async membershipFilterOf(
    segment: ContactSegmentDocument,
  ): Promise<FilterQuery<any>> {
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

  /**
   * Recount and store the size, without ever failing the save over it.
   *
   * The count is decoration; the definition is the record. A timeout leaves
   * `cachedCount` null, which the UI renders as "not counted" rather than as
   * zero — a segment that silently reports nobody in it is how a campaign gets
   * abandoned for the wrong reason.
   */
  private async refreshCount(segment: ContactSegmentDocument): Promise<void> {
    let count: number | null = null;
    try {
      count = await this.contacts
        .countDocuments({
          $and: [{ deletedAt: null }, await this.membershipFilterOf(segment)],
        })
        .maxTimeMS(COUNT_TIMEOUT_MS)
        .exec();
    } catch (error) {
      this.logger.warn(
        `Segment ${segment.name} could not be counted: ${(error as Error).message}`,
      );
    }

    segment.set({ cachedCount: count, countedAt: new Date() });
    await segment.save();
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
      cachedCount: doc.cachedCount ?? null,
      countedAt: doc.countedAt ?? null,
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
