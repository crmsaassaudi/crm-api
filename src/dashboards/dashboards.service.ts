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

  async findAll(): Promise<DashboardDocument[]> {
    return this.model
      .find({
        tenantId: this.tenantId,
        $or: [{ ownerId: this.userId }, { isShared: true }],
      })
      .sort({ updatedAt: -1 })
      .lean();
  }

  // ── Get one ───────────────────────────────────────────────────────────────

  async findOne(id: string): Promise<DashboardDocument> {
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
    return doc;
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
    await this.model.deleteOne({ _id: id });
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
    return copy;
  }
}
