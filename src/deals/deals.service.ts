import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Model } from 'mongoose';
import { Readable } from 'stream';
import { DealRepository } from './infrastructure/persistence/document/repositories/deal.repository';
import { Deal } from './domain/deal';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EntityAuditService } from '../common/audit/entity-audit.service';
import {
  ImportStorageService,
  ImportStorageFactory,
  ImportJobSchemaClass,
  ImportJobDocument,
  detectFormat,
  createParser,
} from '../common/import';
import {
  DEAL_IMPORT_QUEUE,
  DEAL_EXPORT_QUEUE,
  DEAL_IMPORT_MAX_FILE_BYTES,
  DEAL_IMPORT_MAPPABLE_FIELDS,
} from './deals.constants';
import { StartDealImportDto } from './dto/start-deal-import.dto';
import { ExportRequestService, ExportRequestDto } from '../common/export';
import { CrmSettingsService } from '../crm-settings/crm-settings.service';

@Injectable()
export class DealsService {
  private readonly logger = new Logger(DealsService.name);
  private readonly importStorage: ImportStorageService;

  constructor(
    private readonly repository: DealRepository,
    private readonly cls: ClsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly entityAudit: EntityAuditService,
    private readonly storageFactory: ImportStorageFactory,
    @InjectQueue(DEAL_IMPORT_QUEUE)
    private readonly importQueue: Queue,
    @InjectQueue(DEAL_EXPORT_QUEUE)
    private readonly exportQueue: Queue,
    @InjectModel(ImportJobSchemaClass.name)
    private readonly importJobModel: Model<ImportJobDocument>,
    private readonly exportRequest: ExportRequestService,
    private readonly crmSettings: CrmSettingsService,
  ) {
    this.importStorage = this.storageFactory.create('deals');
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * ObjectId ref fields that should be converted from '' to undefined.
   * Prevents Mongoose CastError when empty strings hit ObjectId casts.
   */
  private static readonly OBJECT_ID_FIELDS = [
    'accountId',
    'ownerId',
    'sourceId',
    'stageId',
    'pipelineId',
    'omniConversationId',
  ] as const;

  /** Convert empty string ObjectId refs to undefined in-place. */
  private cleanRefs<T extends Record<string, any>>(data: T): T {
    const mutable = data as Record<string, unknown>;
    for (const key of DealsService.OBJECT_ID_FIELDS) {
      if (mutable[key] === '') {
        mutable[key] = undefined;
      }
    }
    return data;
  }

  /**
   * Validate tenant-configurable required fields.
   * Reads the layout_settings from CrmSettings (30s cache) and checks
   * that all fields marked isRequired=true have a non-empty value.
   */
  private async validateRequiredFields(
    data: Record<string, any>,
    mode: 'create' | 'update',
  ): Promise<void> {
    const layoutSettings = await this.crmSettings.getSetting('layout_settings');
    const layout = layoutSettings?.groupLayouts?.['default'];
    const fieldConfigs: Array<{
      key: string;
      isRequired: boolean;
      isVisible: boolean;
    }> = layout?.Deal || [];

    const errors: Record<string, string> = {};

    for (const field of fieldConfigs) {
      if (!field.isRequired) continue;

      // On update, only validate fields that are present in the payload.
      if (mode === 'update' && !(field.key in data)) continue;

      const value = data[field.key];
      const isEmpty =
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0);

      if (isEmpty) {
        errors[field.key] = `${field.key} is required`;
      }
    }

    if (Object.keys(errors).length > 0) {
      throw new UnprocessableEntityException({
        status: 422,
        errors,
      });
    }
  }

  // ─────────────────────────── EXPORT ───────────────────────────

  exportDeals(
    dto: ExportRequestDto,
  ): Promise<{ jobId: string; status: 'queued' }> {
    return this.exportRequest.enqueue({
      entityType: 'deal',
      queue: this.exportQueue,
      format: dto.format,
      ids: dto.ids,
      columns: dto.columns,
      filterSnapshot: { ids: dto.ids },
    });
  }

  getExportStatus(jobId: string) {
    return this.exportRequest.status(this.exportQueue, jobId);
  }

  cancelExport(jobId: string) {
    return this.exportRequest.cancel('deal', jobId);
  }

  listExportJobs(options: { page?: number; limit?: number; status?: string }) {
    return this.exportRequest.list('deal', this.exportQueue, options);
  }

  getExportDownload(token: string) {
    return this.exportRequest.download('deals', token);
  }

  private getCurrentUserId(): string | undefined {
    return this.cls.get('userId') ?? this.cls.get('user.id');
  }

  private resolveTenantId(): string {
    return this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
  }

  /** Resolve a display filename from DTO, falling back to the fileKey basename. */
  private resolveImportFileName(dto: StartDealImportDto): string {
    return dto.fileName ?? dto.fileKey.split('/').pop() ?? 'unknown';
  }

  /** Resolve the import file format from the DTO or infer from fileKey extension. */
  private resolveImportFileFormat(dto: StartDealImportDto): string {
    return dto.fileFormat ?? (dto.fileKey.endsWith('.xlsx') ? 'xlsx' : 'csv');
  }

  async create(data: Partial<Deal>): Promise<Deal> {
    this.cleanRefs(data as Record<string, any>);
    await this.validateRequiredFields(data as Record<string, any>, 'create');

    return this.repository.create({
      ...data,
      name: data.title || data.name,
    } as any);
  }

  async findAll(filter: any): Promise<any> {
    return this.repository.findManyWithPagination({
      filterOptions: filter,
      paginationOptions: {
        page: Number(filter.page) || 1,
        limit: Number(filter.limit) || 10,
      },
    });
  }

  async findOne(id: string): Promise<Deal | null> {
    return this.repository.findOne({ _id: id });
  }

  async update(id: string, data: Partial<Deal>): Promise<Deal | null> {
    // Snapshot before update for audit trail
    const existingDeal = await this.repository.findOne({ _id: id });

    this.cleanRefs(data as Record<string, any>);
    await this.validateRequiredFields(data as Record<string, any>, 'update');

    const updated = await this.repository.update(id, {
      ...data,
      name: data.title || data.name,
    } as any);

    // Emit audit trail event: field-level change tracking
    if (updated) {
      this.entityAudit.emit({
        entity: 'deal',
        entityType: 'DEAL',
        entityId: id,
        kind: 'updated',
        oldSnapshot: existingDeal ?? {},
        newSnapshot: updated,
      });
    }

    return updated;
  }

  async remove(id: string): Promise<void> {
    return this.repository.remove(id);
  }

  /**
   * Get all tickets linked to this deal (via ticket.dealId).
   * Delegates to the tickets endpoint filter rather than a direct repo call
   * to avoid a circular module dependency between Deals ↔ Tickets.
   */
  async getLinkedTickets(
    dealId: string,
  ): Promise<{ data: any[]; total: number }> {
    // The tickets collection stores dealId as a field — query it directly
    // through this service's own DB connection by casting to any.
    const ticketCollection = (this.repository as any).model?.db?.collection
      ? (this.repository as any).model.db.collection('tickets')
      : null;

    if (!ticketCollection) {
      return { data: [], total: 0 };
    }

    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    const { Types } = await import('mongoose');

    const filter: any = { dealId: dealId, deletedAt: null };
    if (tenantId) {
      try {
        filter.tenantId = new Types.ObjectId(String(tenantId));
      } catch {
        filter.tenantId = tenantId;
      }
    }

    const [data, total] = await Promise.all([
      ticketCollection.find(filter).sort({ createdAt: -1 }).limit(50).toArray(),
      ticketCollection.countDocuments(filter),
    ]);

    return { data, total };
  }
  // ──────────────────────────── DEAL IMPORT ────────────────────────────

  async uploadImportFile(file: {
    buffer: Buffer;
    originalname: string;
    size: number;
  }): Promise<{ fileKey: string; format: string; headers: string[] }> {
    if (!file) throw new BadRequestException('No file uploaded');
    if (file.size > DEAL_IMPORT_MAX_FILE_BYTES) {
      throw new BadRequestException(
        `File exceeds the ${DEAL_IMPORT_MAX_FILE_BYTES / (1024 * 1024)}MB limit`,
      );
    }
    const format = detectFormat(file.originalname);
    const parser = createParser(format);
    const headers = await parser.readHeaders(Readable.from(file.buffer));
    if (headers.length === 0) {
      throw new BadRequestException('File has no header row');
    }
    const { fileKey } = await this.importStorage.storeImportFile({
      buffer: file.buffer,
      originalname: file.originalname,
    });
    return { fileKey, format, headers };
  }

  async startImport(
    dto: StartDealImportDto,
  ): Promise<{ jobId: string; status: 'queued' }> {
    const mappedFields = new Set(Object.values(dto.mapping ?? {}));
    if (!mappedFields.has('title')) {
      throw new BadRequestException('mapping must include title');
    }

    const validFields = new Set<string>(DEAL_IMPORT_MAPPABLE_FIELDS);
    const unmapped = Object.values(dto.mapping).filter(
      (f) => !validFields.has(f),
    );
    if (unmapped.length) {
      throw new BadRequestException(
        `Invalid mapping target(s): ${unmapped.join(', ')}`,
      );
    }

    if (dto.deduplication) {
      const allowed = new Set(['title', 'externalId']);
      const bad = dto.deduplication.matchingFields.filter(
        (f) => !allowed.has(f),
      );
      if (bad.length) {
        throw new BadRequestException(
          `Unsupported dedup matchingFields: ${bad.join(', ')}`,
        );
      }
    }

    const exists = await this.importStorage.importFileExists(dto.fileKey);
    if (!exists) {
      throw new BadRequestException(
        'fileKey not found in storage — upload the file again',
      );
    }

    const tenantId = this.resolveTenantId();
    const userId = this.getCurrentUserId() ?? 'system';

    const job = await this.importQueue.add('import', {
      tenantId,
      userId,
      fileKey: dto.fileKey,
      mapping: dto.mapping,
      deduplication: dto.deduplication,
      dryRun: dto.dryRun ?? false,
      triggerAutomations: dto.triggerAutomations ?? false,
      estimatedRows: dto.estimatedRows,
      fileName: this.resolveImportFileName(dto),
    });

    try {
      await this.importJobModel.create({
        tenantId,
        userId,
        entityType: 'deal',
        fileName: this.resolveImportFileName(dto),
        fileFormat: this.resolveImportFileFormat(dto),
        rowCount: dto.estimatedRows ?? 0,
        status: 'queued',
        bullJobId: String(job.id),
        dryRun: dto.dryRun ?? false,
        mapping: dto.mapping,
        deduplication: dto.deduplication,
        triggerAutomations: dto.triggerAutomations ?? false,
        ip: this.cls.get('requestIp'),
        userAgent: this.cls.get('userAgent'),
        startedAt: new Date(),
      });
    } catch (err) {
      this.logger.warn(
        `Failed to persist deal import history: ${(err as Error).message}`,
      );
    }

    return { jobId: String(job.id), status: 'queued' };
  }

  async listImportJobs(options: {
    page?: number;
    limit?: number;
    status?: string;
  }) {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    const userId = this.getCurrentUserId() ?? 'system';
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(50, Math.max(1, options.limit ?? 10));
    const skip = (page - 1) * limit;
    const filter: Record<string, any> = {
      tenantId,
      userId,
      entityType: 'deal',
    };
    if (
      options.status &&
      ['queued', 'active', 'completed', 'failed'].includes(options.status)
    )
      filter.status = options.status;

    const [data, total] = await Promise.all([
      this.importJobModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'firstName lastName email avatar')
        .lean()
        .exec(),
      this.importJobModel.countDocuments(filter).exec(),
    ]);

    for (const doc of data) {
      const record = doc as Record<string, any>;
      if (record.status === 'active' || record.status === 'queued') {
        try {
          const bullJob = await this.importQueue.getJob(record.bullJobId);
          if (bullJob) {
            record.status = await bullJob.getState();
            if (bullJob.progress && typeof bullJob.progress === 'object')
              record.progress = bullJob.progress;
          }
        } catch {}
      }
      // Extract populated user object
      if (
        record.userId &&
        typeof record.userId === 'object' &&
        record.userId.firstName
      ) {
        record.user = {
          firstName: record.userId.firstName,
          lastName: record.userId.lastName,
          email: record.userId.email,
          avatar: record.userId.avatar,
        };
        record.userId = String(record.userId._id);
      }
    }
    return { data, total, page, limit };
  }

  async getImportJobDetail(id: string) {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    const userId = this.getCurrentUserId() ?? 'system';
    const doc = await this.importJobModel
      .findOne({ _id: id, tenantId, userId, entityType: 'deal' })
      .lean()
      .exec();
    if (!doc) throw new NotFoundException('Import job not found');
    if (doc.status === 'active' || doc.status === 'queued') {
      const record = doc as Record<string, any>;
      try {
        const bullJob = await this.importQueue.getJob(doc.bullJobId);
        if (bullJob) {
          record.status = await bullJob.getState();
          if (bullJob.progress && typeof bullJob.progress === 'object')
            record.progress = bullJob.progress;
        }
      } catch {}
    }
    return doc;
  }

  async getImportStatus(jobId: string) {
    const job = await this.importQueue.getJob(jobId);
    if (!job) throw new NotFoundException('Import job not found');
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    const userId = this.getCurrentUserId() ?? 'system';
    if (
      String(job.data?.tenantId ?? '') !== String(tenantId ?? '') ||
      (job.data?.userId && String(job.data.userId) !== String(userId ?? ''))
    )
      throw new NotFoundException('Import job not found');
    return {
      status: await job.getState(),
      progress: job.progress,
      result: job.returnvalue,
      failedReason: job.failedReason,
    };
  }

  getImportReport(token: string) {
    return this.importStorage.readLocalReport(token);
  }
}
