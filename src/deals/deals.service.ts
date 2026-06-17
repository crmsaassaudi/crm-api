import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
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
  ) {
    this.importStorage = this.storageFactory.create('deals');
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
    return this.cls.get('userId') || this.cls.get('user.id');
  }

  async create(data: Partial<Deal>): Promise<Deal> {
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    return this.repository.create({
      ...data,
      name: data.title || data.name,
      ownerId,
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

    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const updated = await this.repository.update(id, {
      ...data,
      name: data.title || data.name,
      ownerId,
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

    const tenantId = this.cls.get('activeTenantId') || this.cls.get('tenantId');
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
      fileName: dto.fileName || dto.fileKey.split('/').pop() || 'unknown',
    });

    try {
      await this.importJobModel.create({
        tenantId,
        userId,
        entityType: 'deal',
        fileName: dto.fileName || dto.fileKey.split('/').pop() || 'unknown',
        fileFormat:
          dto.fileFormat || (dto.fileKey.endsWith('.xlsx') ? 'xlsx' : 'csv'),
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
    const tenantId = this.cls.get('activeTenantId') || this.cls.get('tenantId');
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
      if (doc.status === 'active' || doc.status === 'queued') {
        try {
          const bullJob = await this.importQueue.getJob(doc.bullJobId);
          if (bullJob) {
            (doc as any).status = await bullJob.getState();
            if (bullJob.progress && typeof bullJob.progress === 'object')
              (doc as any).progress = bullJob.progress;
          }
        } catch {}
      }
      // Extract populated user object
      if (
        (doc as any).userId &&
        typeof (doc as any).userId === 'object' &&
        (doc as any).userId.firstName
      ) {
        (doc as any).user = {
          firstName: (doc as any).userId.firstName,
          lastName: (doc as any).userId.lastName,
          email: (doc as any).userId.email,
          avatar: (doc as any).userId.avatar,
        };
        (doc as any).userId = String((doc as any).userId._id);
      }
    }
    return { data, total, page, limit };
  }

  async getImportJobDetail(id: string) {
    const tenantId = this.cls.get('activeTenantId') || this.cls.get('tenantId');
    const userId = this.getCurrentUserId() ?? 'system';
    const doc = await this.importJobModel
      .findOne({ _id: id, tenantId, userId, entityType: 'deal' })
      .lean()
      .exec();
    if (!doc) throw new NotFoundException('Import job not found');
    if (doc.status === 'active' || doc.status === 'queued') {
      try {
        const bullJob = await this.importQueue.getJob(doc.bullJobId);
        if (bullJob) {
          (doc as any).status = await bullJob.getState();
          if (bullJob.progress && typeof bullJob.progress === 'object')
            (doc as any).progress = bullJob.progress;
        }
      } catch {}
    }
    return doc;
  }

  async getImportStatus(jobId: string) {
    const job = await this.importQueue.getJob(jobId);
    if (!job) throw new NotFoundException('Import job not found');
    const tenantId = this.cls.get('activeTenantId') || this.cls.get('tenantId');
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
