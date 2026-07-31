import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { AutomationEventPayload } from '../automation-rules/events/automation-event.payload';
import { AutomationOutboxService } from '../automation-rules/events/automation-outbox.service';
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
  ACCOUNT_MAX_BULK_TAG_SIZE,
} from './accounts.constants';
import { StartAccountImportDto } from './dto/start-account-import.dto';
import { ExportRequestService, ExportRequestDto } from '../common/export';
import { TagsService } from '../tags/tags.service';
import { CustomFieldValueValidator } from '../custom-fields/custom-field-value.validator';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { loadCustomFieldDefinitions } from '../utils/custom-field-filter';
import {
  compareCompanyIdentity,
  deriveCompanyIdentity,
  type CompanyMatchConfidence,
} from '../common/identity/company-identity';

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);
  private readonly importStorage: ImportStorageService;

  constructor(
    private readonly repository: AccountRepository,
    // Enforces the tenant's custom_fields registry on the Mixed `customFields`
    // column — the same H-6 gap the contact audit found.
    private readonly customFieldValidator: CustomFieldValueValidator,
    private readonly entityAudit: EntityAuditService,
    private readonly cls: ClsService,
    private readonly automationOutbox: AutomationOutboxService,
    private readonly storageFactory: ImportStorageFactory,
    @InjectQueue(ACCOUNT_IMPORT_QUEUE)
    private readonly importQueue: Queue,
    @InjectQueue(ACCOUNT_EXPORT_QUEUE)
    private readonly exportQueue: Queue,
    @InjectModel(ImportJobSchemaClass.name)
    private readonly importJobModel: Model<ImportJobDocument>,
    private readonly exportRequest: ExportRequestService,
    private readonly tagsService: TagsService,
    @Optional() private readonly customFields?: CustomFieldsService,
  ) {
    this.importStorage = this.storageFactory.create('accounts');
  }

  async bulkTagAccounts(params: {
    accountIds: string[];
    tags: string[];
  }): Promise<{ success: true; matchedCount: number; modifiedCount: number }> {
    const accountIds = Array.from(new Set(params.accountIds || [])).filter(
      Boolean,
    );
    const tags = Array.from(
      new Set((params.tags || []).map((tag) => tag.trim()).filter(Boolean)),
    );

    if (accountIds.length === 0) {
      throw new BadRequestException('accountIds is required');
    }
    if (accountIds.length > ACCOUNT_MAX_BULK_TAG_SIZE) {
      throw new BadRequestException(
        `Bulk operation exceeds maximum of ${ACCOUNT_MAX_BULK_TAG_SIZE} accounts per request. Received: ${accountIds.length}`,
      );
    }
    if (tags.length === 0) {
      throw new BadRequestException('tags is required');
    }

    await this.tagsService.validateTagIds('Account', tags);

    const result = await this.repository.addTagsToAccounts(accountIds, tags);

    return {
      success: true,
      ...result,
    };
  }

  // ─────────────────────────── EXPORT ───────────────────────────

  async exportAccounts(
    dto: ExportRequestDto,
  ): Promise<{ jobId: string; status: 'queued' }> {
    const querySnapshot = {
      filters: dto.filters ?? [],
      search: dto.search,
    };
    const legacyFilters = {
      ...querySnapshot,
      __customFieldDefinitions: await loadCustomFieldDefinitions(
        this.customFields,
        'Account',
        dto.filters,
      ),
    };
    return this.exportRequest.enqueue({
      entityType: 'account',
      queue: this.exportQueue,
      format: dto.format,
      ids: dto.ids,
      columns: dto.columns,
      legacyFilters,
      filterSnapshot: { ids: dto.ids, ...querySnapshot },
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

  private resolveTenantId(): string {
    return this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
  }

  /** Resolve a display filename from DTO, falling back to the fileKey basename. */
  private resolveImportFileName(dto: StartAccountImportDto): string {
    return dto.fileName ?? dto.fileKey.split('/').pop() ?? 'unknown';
  }

  /** Resolve the import file format from the DTO or infer from the fileKey extension. */
  private resolveImportFileFormat(dto: StartAccountImportDto): string {
    return dto.fileFormat ?? (dto.fileKey.endsWith('.xlsx') ? 'xlsx' : 'csv');
  }

  async create(data: Partial<Account>): Promise<Account> {
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const phones = data.phones ?? [];
    const emails = data.emails ?? [];

    // Same Mixed-column gap as Contact (H-6) and Deal: the custom_fields registry
    // declared types, picklists and required flags that no write path enforced.
    const customFields = await this.customFieldValidator.validate(
      'Account',
      data.customFields,
    );

    const account = await this.automationOutbox.runWithEvent(
      (session) =>
        this.repository.create(
          {
            ...data,
            phones,
            emails,
            ownerId,
            ...(customFields !== undefined ? { customFields } : {}),
            // Comparison keys, derived from the display values the user typed. Stored
            // so duplicate lookups are indexed rather than recomputed per query.
            ...this.deriveIdentityKeys(data),
          } as any,
          session,
        ),
      (created) => this.buildAutomationEvent('record_created', created),
    );

    this.entityAudit.emit({
      entity: 'account',
      entityType: 'ACCOUNT',
      entityId: account.id,
      kind: 'created',
      newSnapshot: account,
    });

    return account;
  }

  /**
   * The stored comparison keys for an account payload.
   *
   * `partial` is for PATCH: only emit a key when its source field is actually present,
   * because deriving from an absent field yields '' and would blank a key the record
   * already had — turning an unrelated edit into a silent loss of duplicate detection.
   */
  private deriveIdentityKeys(
    data: Partial<Account>,
    options: { partial?: boolean } = {},
  ): Record<string, string> {
    const identity = deriveCompanyIdentity(data);
    const keys: Record<string, string> = {};

    if (!options.partial || data.name !== undefined) {
      keys.nameKey = identity.nameKey;
    }
    if (!options.partial || data.website !== undefined) {
      keys.websiteDomain = identity.domain;
    }
    if (!options.partial || data.taxId !== undefined) {
      keys.taxIdKey = identity.taxIdKey;
    }

    return keys;
  }

  /**
   * Accounts that look like the same organisation as the supplied one.
   *
   * Advisory, never blocking. A company has no key that settles the question the way an
   * email address does: a shared tax id is conclusive, a shared domain nearly always
   * is, and a matching name after suffix-stripping frequently is not — "Acme Ltd" and
   * "Acme GmbH" reduce to the same key and are different legal entities. So this
   * returns each candidate WITH its confidence and lets a human decide, rather than
   * refusing the write on a signal that cannot be certain.
   *
   * Ranked strongest-first so the caller can show the best evidence without sorting.
   */
  async checkDuplicate(params: {
    name?: string;
    website?: string;
    taxId?: string;
    excludeId?: string;
  }): Promise<{
    isDuplicate: boolean;
    duplicates: Array<{
      id: string;
      name: string;
      website?: string;
      confidence: CompanyMatchConfidence;
      matchedOn: string;
    }>;
  }> {
    const identity = deriveCompanyIdentity(params);
    if (!identity.nameKey && !identity.domain && !identity.taxIdKey) {
      return { isDuplicate: false, duplicates: [] };
    }

    const candidates = await this.repository.findIdentityCandidates(
      {
        nameKey: identity.nameKey || undefined,
        websiteDomain: identity.domain || undefined,
        taxIdKey: identity.taxIdKey || undefined,
      },
      params.excludeId,
    );

    const rank: Record<CompanyMatchConfidence, number> = {
      exact: 0,
      strong: 1,
      weak: 2,
    };

    const duplicates = candidates
      .map((candidate) => {
        const match = compareCompanyIdentity(
          identity,
          deriveCompanyIdentity(candidate),
        );
        return match ? { candidate, match } : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => rank[a.match.confidence] - rank[b.match.confidence])
      .map(({ candidate, match }) => ({
        id: candidate.id,
        name: candidate.name,
        website: candidate.website,
        confidence: match.confidence,
        matchedOn: match.matchedOn,
      }));

    return { isDuplicate: duplicates.length > 0, duplicates };
  }

  async findAll(filter: any): Promise<any> {
    const limit = clampPaginationLimit(filter.limit);
    const filterOptions = {
      ...filter,
      __customFieldDefinitions: await loadCustomFieldDefinitions(
        this.customFields,
        'Account',
        filter.filters,
      ),
    };

    if (resolvePaginationMode(filter) === 'cursor') {
      return this.repository.findManyWithCursorPagination({
        filterOptions,
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
      filterOptions,
      paginationOptions: {
        page: Number(filter.page ?? 1) || 1,
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
    const customFields = await this.customFieldValidator.validate(
      'Account',
      data.customFields,
      { partial: true },
    );
    const changedFields = Object.keys(data).filter((k) => k !== 'updatedBy');
    const updated = await this.automationOutbox.runWithEvent(
      (session) =>
        this.repository.update(
          id,
          {
            ...data,
            ...(phones !== undefined ? { phones } : {}),
            ...(emails !== undefined ? { emails } : {}),
            ...(customFields !== undefined ? { customFields } : {}),
            // Only re-derive when an identity field is actually in the patch —
            // deriving from an absent field would blank the stored key.
            ...this.deriveIdentityKeys(data, { partial: true }),
            ownerId,
          } as any,
          session,
        ),
      (result) =>
        result
          ? this.buildAutomationEvent('field_updated', result, changedFields)
          : null,
    );

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

  // ──────────────────────── RECYCLE BIN ────────────────────────
  //
  // `remove()` is a soft delete (the schema declares `deletedAt`), so without these
  // two methods a deleted account was invisible everywhere and recoverable nowhere —
  // strictly worse than the hard delete it replaced, because the row also stayed in
  // the database forever.

  async listDeleted(options: { page?: number; limit?: number }): Promise<{
    data: Account[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(100, Math.max(1, options.limit ?? 25));
    const { data, total } = await this.repository.findDeleted({ page, limit });
    return { data, total, page, limit };
  }

  async restore(id: string): Promise<Account> {
    const restored = await this.repository.restore(id);
    if (!restored) {
      throw new NotFoundException(
        'Account not found in the recycle bin — it may already have been purged',
      );
    }

    this.entityAudit.emit({
      entity: 'account',
      entityType: 'ACCOUNT',
      entityId: id,
      kind: 'updated',
      oldSnapshot: { _deleted: true } as any,
      newSnapshot: restored,
    });

    return restored;
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

    const tenantId = this.resolveTenantId();
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
      fileName: this.resolveImportFileName(dto),
    });

    // Persist to MongoDB for import history
    try {
      await this.importJobModel.create({
        tenantId,
        userId,
        entityType: 'account',
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
    const tenantId = this.resolveTenantId();
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
        .populate('userId', 'firstName lastName email avatar')
        .lean()
        .exec(),
      this.importJobModel.countDocuments(filter).exec(),
    ]);

    for (const doc of data) {
      await this.enrichJobWithBullMQProgress(doc);
      this.extractPopulatedUser(doc);
    }

    return { data, total, page, limit };
  }

  /** Enrich active/queued jobs with real-time BullMQ progress. */
  private async enrichJobWithBullMQProgress(doc: any): Promise<void> {
    if (doc.status !== 'active' && doc.status !== 'queued') return;
    try {
      const bullJob = await this.importQueue.getJob(doc.bullJobId);
      if (!bullJob) return;
      doc.status = await bullJob.getState();
      if (bullJob.progress && typeof bullJob.progress === 'object') {
        doc.progress = bullJob.progress;
      }
    } catch {
      // BullMQ job may have been cleaned up — keep MongoDB status
    }
  }

  /** Extract populated user object from Mongoose populate result. */
  private extractPopulatedUser(doc: any): void {
    if (doc.userId && typeof doc.userId === 'object' && doc.userId.firstName) {
      doc.user = {
        firstName: doc.userId.firstName,
        lastName: doc.userId.lastName,
        email: doc.userId.email,
        avatar: doc.userId.avatar,
      };
      doc.userId = String(doc.userId._id);
    }
  }

  async getImportJobDetail(id: string) {
    const tenantId = this.resolveTenantId();
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

    const tenantId = this.resolveTenantId();
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

  /**
   * Notify the Automation Engine after a successful write.
   *
   * Account triggers were selectable in the workflow builder but this service never
   * emitted the event, so `record_created.Account` and `field_updated.Account`
   * workflows could be authored, published and activated without ever firing.
   * AutomationEventPayload's own docblock claimed this service was an emitter.
   */
  private buildAutomationEvent(
    event: 'record_created' | 'field_updated',
    record: Account,
    changedFields?: string[],
  ): AutomationEventPayload | null {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    if (!tenantId) {
      throw new Error('Tenant context is required for Account automation.');
    }

    const payload: AutomationEventPayload = {
      tenantId,
      event,
      object: 'Account',
      recordId: record.id,
      data: record as any,
      ...(changedFields ? { changedFields } : {}),
      automationDepth: 0,
      // Feeds `runAs: 'trigger_user'`. Read from CLS at emit time because the
      // queue worker that evaluates this event has no request to read it from.
      triggerUserId: this.cls.get('userId') ?? null,
    };

    return payload;
  }
}
