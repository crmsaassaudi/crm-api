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
import { ClsService } from 'nestjs-cls';
import { Readable } from 'stream';
import { AccountRepository } from './infrastructure/persistence/document/repositories/account.repository';
import { Account } from './domain/account';
import {
  DEFAULT_CURSOR_COUNT_LIMIT,
  clampPaginationLimit,
  resolvePaginationMode,
} from '../utils/cursor-pagination';
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
  ACCOUNT_IMPORT_QUEUE,
  ACCOUNT_EXPORT_QUEUE,
  ACCOUNT_IMPORT_MAX_FILE_BYTES,
  ACCOUNT_IMPORT_MAPPABLE_FIELDS,
} from './accounts.constants';
import { StartAccountImportDto } from './dto/start-account-import.dto';
import { ExportRequestService, ExportRequestDto } from '../common/export';

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);
  private readonly importStorage: ImportStorageService;

  constructor(
    private readonly repository: AccountRepository,
    private readonly entityAudit: EntityAuditService,
    private readonly cls: ClsService,
    private readonly storageFactory: ImportStorageFactory,
    @InjectQueue(ACCOUNT_IMPORT_QUEUE)
    private readonly importQueue: Queue,
    @InjectQueue(ACCOUNT_EXPORT_QUEUE)
    private readonly exportQueue: Queue,
    @InjectModel(ImportJobSchemaClass.name)
    private readonly importJobModel: Model<ImportJobDocument>,
    private readonly exportRequest: ExportRequestService,
  ) {
    this.importStorage = this.storageFactory.create('accounts');
  }

  // ─────────────────────────── EXPORT ───────────────────────────

  exportAccounts(
    dto: ExportRequestDto,
  ): Promise<{ jobId: string; status: 'queued' }> {
    return this.exportRequest.enqueue({
      entityType: 'account',
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
    return this.exportRequest.cancel('account', jobId);
  }

  listExportJobs(options: { page?: number; limit?: number; status?: string }) {
    return this.exportRequest.list('account', this.exportQueue, options);
  }

  getExportDownload(token: string) {
    return this.exportRequest.download('accounts', token);
  }

  private getCurrentUserId(): string {
    return this.cls.get('userId') ?? 'system';
  }

  async create(data: Partial<Account>): Promise<Account> {
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const phones = data.phones ?? [];
    const emails = data.emails ?? [];
    const account = await this.repository.create({
      ...data,
      phones,
      emails,
      ownerId,
    } as any);

    this.entityAudit.emit({
      entity: 'account',
      entityType: 'ACCOUNT',
      entityId: account.id,
      kind: 'created',
      newSnapshot: account,
    });

    return account;
  }

  async findAll(filter: any): Promise<any> {
    const limit = clampPaginationLimit(filter.limit);

    if (resolvePaginationMode(filter) === 'cursor') {
      return this.repository.findManyWithCursorPagination({
        filterOptions: filter,
        paginationOptions: {
          limit,
          cursor: filter.cursor,
          direction: filter.direction,
          sortBy: filter.sortBy,
          sortOrder: filter.sortOrder,
          countLimit: DEFAULT_CURSOR_COUNT_LIMIT,
        },
      });
    }

    return this.repository.findManyWithPagination({
      filterOptions: filter,
      paginationOptions: {
        page: Number(filter.page) || 1,
        limit,
      },
    });
  }

  async findOne(id: string): Promise<Account | null> {
    return this.repository.findOne({ _id: id });
  }

  async update(id: string, data: Partial<Account>): Promise<Account | null> {
    // Snapshot before write so AuditLogListener can compute a field-level
    // diff. Previously this service did not emit any audit signal — the
    // 2026-05-28 review flagged it as a coverage gap.
    const existing = await this.repository.findOne({ _id: id });
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const phones = data.phones;
    const emails = data.emails;
    const updated = await this.repository.update(id, {
      ...data,
      ...(phones !== undefined ? { phones } : {}),
      ...(emails !== undefined ? { emails } : {}),
      ownerId,
    } as any);

    if (updated) {
      this.entityAudit.emit({
        entity: 'account',
        entityType: 'ACCOUNT',
        entityId: id,
        kind: 'updated',
        oldSnapshot: existing ?? {},
        newSnapshot: updated,
      });
    }

    return updated;
  }

  async remove(id: string): Promise<void> {
    const existing = await this.repository.findOne({ _id: id });
    await this.repository.remove(id);
    this.entityAudit.emit({
      entity: 'account',
      entityType: 'ACCOUNT',
      entityId: id,
      kind: 'updated',
      oldSnapshot: existing ?? {},
      newSnapshot: { _deleted: true } as any,
    });
  }

  // ──────────────────────────── ACCOUNT IMPORT ────────────────────────────

  /**
   * Store an uploaded .csv/.xlsx and return its storage key plus the parsed
   * header row so the client can build the field-mapping UI.
   */
  async uploadImportFile(file: {
    buffer: Buffer;
    originalname: string;
    size: number;
  }): Promise<{ fileKey: string; format: string; headers: string[] }> {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    if (file.size > ACCOUNT_IMPORT_MAX_FILE_BYTES) {
      throw new BadRequestException(
        `File exceeds the ${ACCOUNT_IMPORT_MAX_FILE_BYTES / (1024 * 1024)}MB limit`,
      );
    }
    const format = detectFormat(file.originalname);

    // Parse just the header row before persisting so we fail fast on garbage.
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
    dto: StartAccountImportDto,
  ): Promise<{ jobId: string; status: 'queued' }> {
    // 1. Required-field mapping: schema marks name required.
    const mappedFields = new Set(Object.values(dto.mapping ?? {}));
    if (!mappedFields.has('name')) {
      throw new BadRequestException('mapping must include name');
    }

    // 2. Only accept valid mappable fields.
    const validFields = new Set<string>(ACCOUNT_IMPORT_MAPPABLE_FIELDS);
    const unmapped = Object.values(dto.mapping).filter(
      (f) => !validFields.has(f),
    );
    if (unmapped.length) {
      throw new BadRequestException(
        `Invalid mapping target(s): ${unmapped.join(', ')}`,
      );
    }

    // 3. Dedup matching fields must be valid.
    if (dto.deduplication) {
      const allowed = new Set(['name', 'emails', 'taxId']);
      const bad = dto.deduplication.matchingFields.filter(
        (f) => !allowed.has(f),
      );
      if (bad.length) {
        throw new BadRequestException(
          `Unsupported dedup matchingFields: ${bad.join(', ')}`,
        );
      }
      const missing = dto.deduplication.matchingFields.filter(
        (f) => !mappedFields.has(f),
      );
      if (missing.length) {
        throw new BadRequestException(
          `Dedup field(s) [${missing.join(', ')}] are not present in the column mapping`,
        );
      }
    }

    // 4. The uploaded file must still exist in storage.
    const exists = await this.importStorage.importFileExists(dto.fileKey);
    if (!exists) {
      throw new BadRequestException(
        'fileKey not found in storage — upload the file again',
      );
    }

    const tenantId = this.cls.get('activeTenantId') || this.cls.get('tenantId');
    const userId = this.getCurrentUserId();

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

    // Persist to MongoDB for import history
    try {
      await this.importJobModel.create({
        tenantId,
        userId,
        entityType: 'account',
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
        startedAt: new Date(),
      });
    } catch (err) {
      this.logger.warn(
        `Failed to persist account import history record: ${(err as Error).message}`,
      );
    }

    return { jobId: String(job.id), status: 'queued' };
  }

  // ─────────────────────── IMPORT HISTORY ───────────────────────────

  async listImportJobs(options: {
    page?: number;
    limit?: number;
    status?: string;
  }): Promise<{
    data: any[];
    total: number;
    page: number;
    limit: number;
  }> {
    const tenantId = this.cls.get('activeTenantId') || this.cls.get('tenantId');
    const userId = this.getCurrentUserId();
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(50, Math.max(1, options.limit ?? 10));
    const skip = (page - 1) * limit;

    const filter: Record<string, any> = {
      tenantId,
      userId,
      entityType: 'account',
    };
    if (
      options.status &&
      ['queued', 'active', 'completed', 'failed'].includes(options.status)
    ) {
      filter.status = options.status;
    }

    const [data, total] = await Promise.all([
      this.importJobModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.importJobModel.countDocuments(filter).exec(),
    ]);

    // For active/queued jobs, enrich with real-time BullMQ progress
    for (const doc of data) {
      if (doc.status === 'active' || doc.status === 'queued') {
        try {
          const bullJob = await this.importQueue.getJob(doc.bullJobId);
          if (bullJob) {
            const state = await bullJob.getState();
            (doc as any).status = state;
            if (bullJob.progress && typeof bullJob.progress === 'object') {
              (doc as any).progress = bullJob.progress;
            }
          }
        } catch {
          // BullMQ job may have been cleaned up — keep MongoDB status
        }
      }
    }

    return { data, total, page, limit };
  }

  async getImportJobDetail(id: string) {
    const tenantId = this.cls.get('activeTenantId') || this.cls.get('tenantId');
    const userId = this.getCurrentUserId();

    const doc = await this.importJobModel
      .findOne({ _id: id, tenantId, userId, entityType: 'account' })
      .lean()
      .exec();
    if (!doc) throw new NotFoundException('Import job not found');

    if (doc.status === 'active' || doc.status === 'queued') {
      try {
        const bullJob = await this.importQueue.getJob(doc.bullJobId);
        if (bullJob) {
          (doc as any).status = await bullJob.getState();
          if (bullJob.progress && typeof bullJob.progress === 'object') {
            (doc as any).progress = bullJob.progress;
          }
        }
      } catch {
        // BullMQ job cleaned up
      }
    }

    return doc;
  }

  async getImportStatus(jobId: string): Promise<{
    status: string;
    progress: unknown;
    result: any;
    failedReason?: string;
  }> {
    const job = await this.importQueue.getJob(jobId);
    if (!job) {
      throw new NotFoundException('Import job not found');
    }

    const tenantId = this.cls.get('activeTenantId') || this.cls.get('tenantId');
    const userId = this.getCurrentUserId();
    if (
      String(job.data?.tenantId ?? '') !== String(tenantId ?? '') ||
      (job.data?.userId && String(job.data.userId) !== String(userId ?? ''))
    ) {
      throw new NotFoundException('Import job not found');
    }

    return {
      status: await job.getState(),
      progress: job.progress,
      result: job.returnvalue,
      failedReason: job.failedReason,
    };
  }

  getImportReport(
    token: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    return this.importStorage.readLocalReport(token);
  }
}
