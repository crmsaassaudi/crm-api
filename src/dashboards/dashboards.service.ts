import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { DashboardSchemaClass, DashboardDocument } from './dashboard.schema';
import { CreateDashboardDto, UpdateDashboardDto } from './dashboard.dto';

@Injectable()
export class DashboardsService {
  private readonly logger = new Logger(DashboardsService.name);

  constructor(
    @InjectModel(DashboardSchemaClass.name)
    private readonly model: Model<DashboardDocument>,
    private readonly cls: ClsService,
  ) {}

  private get tenantId(): string {
    return this.cls.get('tenantId');
  }
  private get userId(): string {
    return this.cls.get('userId');
  }

  // ── List ─────────────────────────────────────────────────────────────────

  async findAll() {
    return this.model
      .find({
        tenantId: this.tenantId,
        $or: [{ ownerId: this.userId }, { isShared: true }],
      })
      .sort({ updatedAt: -1 })
      .lean();
  }

  // ── Get one ───────────────────────────────────────────────────────────────

  async findOne(id: string) {
    const doc = await this.model
      .findOne({ _id: id, tenantId: this.tenantId })
      .lean();
    if (!doc) throw new NotFoundException(`Dashboard ${id} not found`);
    if (!doc.isShared && doc.ownerId !== this.userId) {
      throw new ForbiddenException('Access denied to this dashboard');
    }
    return doc;
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async create(dto: CreateDashboardDto): Promise<DashboardDocument> {
    const doc = await this.model.create({
      tenantId: this.tenantId,
      ownerId: this.userId,
      name: dto.name,
      description: dto.description,
      isShared: dto.isShared ?? false,
      icon: dto.icon ?? 'LayoutDashboard',
      widgets: dto.widgets ?? [],
    });
    this.logger.log(`Dashboard created: ${doc.id} by user=${this.userId}`);
    // `.toObject()`, not the hydrated document: every read here returns
    // `.lean()` output, and the global ClassSerializerInterceptor walks whatever
    // it is handed. Handed a Mongoose document it recursed into the internal
    // state machine and threw `callback is not a function` — a 500 AFTER the
    // insert committed, so the client saw a failure for a dashboard that
    // existed, and a retry made a second one.
    return doc.toObject() as DashboardDocument;
  }

  // ── Update (layout + metadata) ────────────────────────────────────────────

  async update(
    id: string,
    dto: UpdateDashboardDto,
  ): Promise<DashboardDocument> {
    const existing = await this.findOne(id); // throws if not found / forbidden
    if (existing.ownerId !== this.userId) {
      throw new ForbiddenException('Only the owner can modify this dashboard');
    }

    const updated = await this.model.findByIdAndUpdate(
      id,
      { $set: { ...dto } },
      { new: true, lean: true },
    );
    return updated as DashboardDocument;
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async delete(id: string): Promise<void> {
    const existing = await this.findOne(id);
    if (existing.ownerId !== this.userId) {
      throw new ForbiddenException('Only the owner can delete this dashboard');
    }
    // tenantId in the filter even though findOne() above already validated it:
    // a delete must not depend on a caller remembering to pre-read.
    await this.model.deleteOne({ _id: id, tenantId: this.tenantId });
  }

  // ── Duplicate (clone shared dashboard to own) ─────────────────────────────

  async duplicate(id: string): Promise<DashboardDocument> {
    const source = await this.findOne(id);
    const copy = await this.model.create({
      tenantId: this.tenantId,
      ownerId: this.userId,
      name: `${source.name} (Copy)`,
      description: source.description,
      isShared: false,
      icon: source.icon,
      widgets: source.widgets,
    });
    // Same reason as create(): never hand a hydrated document to the serializer.
    return copy.toObject() as DashboardDocument;
  }
}
