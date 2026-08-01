import {
  BadRequestException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { BusinessException } from '../common/exceptions/business.exception';
import { DEAL_ERRORS } from './constants/deal-error-codes';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Model } from 'mongoose';
import { Readable } from 'stream';
import { DealRepository } from './infrastructure/persistence/document/repositories/deal.repository';
import { DealStageSchemaClass } from '../deal-settings/entities/deal-stage.schema';
import { Deal } from './domain/deal';
import { ClsService } from 'nestjs-cls';
import { AutomationEventPayload } from '../automation-rules/events/automation-event.payload';
import { AutomationOutboxService } from '../automation-rules/events/automation-outbox.service';
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
  DEAL_MAX_BULK_TAG_SIZE,
} from './deals.constants';
import { StartDealImportDto } from './dto/start-deal-import.dto';
import { ExportRequestService, ExportRequestDto } from '../common/export';
import { CrmSettingsService } from '../crm-settings/crm-settings.service';
import { TagsService } from '../tags/tags.service';
import { buildCrmReportVisibilityFilter } from '../reports/shared/utils/report-visibility-filter.util';
import { CustomFieldValueValidator } from '../custom-fields/custom-field-value.validator';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { loadCustomFieldDefinitions } from '../utils/custom-field-filter';

@Injectable()
export class DealsService {
  private readonly logger = new Logger(DealsService.name);
  private readonly importStorage: ImportStorageService;

  constructor(
    private readonly repository: DealRepository,
    // Enforces the tenant's custom_fields registry on the Mixed `customFields`
    // column — the same H-6 gap the contact audit found.
    private readonly customFieldValidator: CustomFieldValueValidator,
    private readonly cls: ClsService,
    private readonly automationOutbox: AutomationOutboxService,
    private readonly entityAudit: EntityAuditService,
    private readonly storageFactory: ImportStorageFactory,
    @InjectQueue(DEAL_IMPORT_QUEUE)
    private readonly importQueue: Queue,
    @InjectQueue(DEAL_EXPORT_QUEUE)
    private readonly exportQueue: Queue,
    @InjectModel(ImportJobSchemaClass.name)
    private readonly importJobModel: Model<ImportJobDocument>,
    // The tenant's pipeline stages, for the isWon/isLost flags that define a closed deal.
    @InjectModel(DealStageSchemaClass.name)
    private readonly stageModel: Model<any>,
    private readonly exportRequest: ExportRequestService,
    private readonly crmSettings: CrmSettingsService,
    private readonly tagsService: TagsService,
    @Optional() private readonly customFields?: CustomFieldsService,
  ) {
    this.importStorage = this.storageFactory.create('deals');
  }

  async bulkTagDeals(params: {
    dealIds: string[];
    tags: string[];
  }): Promise<{ success: true; matchedCount: number; modifiedCount: number }> {
    const dealIds = Array.from(new Set(params.dealIds || [])).filter(Boolean);
    const tags = Array.from(
      new Set((params.tags || []).map((tag) => tag.trim()).filter(Boolean)),
    );

    if (dealIds.length === 0) {
      throw new BadRequestException('dealIds is required');
    }
    if (dealIds.length > DEAL_MAX_BULK_TAG_SIZE) {
      throw new BadRequestException(
        `Bulk operation exceeds maximum of ${DEAL_MAX_BULK_TAG_SIZE} deals per request. Received: ${dealIds.length}`,
      );
    }
    if (tags.length === 0) {
      throw new BadRequestException('tags is required');
    }

    await this.tagsService.validateTagIds('Deal', tags);

    const result = await this.repository.addTagsToDeals(dealIds, tags);

    return {
      success: true,
      ...result,
    };
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

  async exportDeals(
    dto: ExportRequestDto,
  ): Promise<{ jobId: string; status: 'queued' }> {
    const filters = [...(dto.filters ?? [])];
    const querySnapshot = { filters, search: dto.search };
    return this.exportRequest.enqueue({
      entityType: 'deal',
      queue: this.exportQueue,
      format: dto.format,
      ids: dto.ids,
      columns: dto.columns,
      legacyFilters: {
        ...querySnapshot,
        __customFieldDefinitions: await loadCustomFieldDefinitions(
          this.customFields,
          'Deal',
          filters,
        ),
      },
      filterSnapshot: { ids: dto.ids, ...querySnapshot },
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

    // `customFields` is a Mixed column: without this, any key of any shape was
    // accepted. The same gap the contact audit found (H-6) — the custom_fields
    // registry defines types, picklists and required flags that nothing enforced,
    // so the same key ended up holding "5", 5 and null across records and report
    // $groups silently split into several buckets.
    const customFields = await this.customFieldValidator.validate(
      'Deal',
      data.customFields,
    );

    const deal = await this.automationOutbox.runWithEvent(
      (session) =>
        this.repository.create(
          {
            ...data,
            name: data.title || data.name,
            ...(customFields !== undefined ? { customFields } : {}),
          } as any,
          session,
        ),
      (created) => this.buildAutomationEvent('record_created', created),
    );
    this.entityAudit.emit({
      entity: 'deal',
      entityType: 'DEAL',
      entityId: deal.id,
      kind: 'created',
      newSnapshot: deal,
    });

    return deal;
  }

  async findAll(filter: any): Promise<any> {
    const filterOptions = {
      ...filter,
      __customFieldDefinitions: await loadCustomFieldDefinitions(
        this.customFields,
        'Deal',
        filter.filters,
      ),
    };
    return this.repository.findManyWithPagination({
      filterOptions,
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
    // `findOne` is scoped by tenant, data-visibility and the ABAC deny, so a
    // miss means "not yours to edit". Refusing here rather than letting the
    // write miss keeps the answer a 404 and skips the validation work a denied
    // request should never pay for.
    if (!existingDeal) {
      throw new NotFoundException(`Deal ${id} not found`);
    }

    this.cleanRefs(data as Record<string, any>);
    await this.validateRequiredFields(data as Record<string, any>, 'update');

    // `partial: true` — a PATCH that does not mention a required custom field must
    // not fail on it; it was already satisfied at create time.
    const customFields = await this.customFieldValidator.validate(
      'Deal',
      data.customFields,
      { partial: true },
    );

    // Stage transitions carry the close timestamps and the reopen guard.
    const stageUpdates: Record<string, any> = {};
    await this.applyStageTransition(existingDeal, data, stageUpdates);

    const changedFields = Object.keys(data).filter((k) => k !== 'updatedBy');
    const updated = await this.automationOutbox.runWithEvent(
      (session) =>
        this.repository.update(
          id,
          {
            ...data,
            name: data.title || data.name,
            ...(customFields !== undefined ? { customFields } : {}),
            ...stageUpdates,
          } as any,
          session,
        ),
      (result) =>
        result
          ? this.buildAutomationEvent('field_updated', result, changedFields)
          : null,
    );

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

  // ──────────────────────── RECYCLE BIN ────────────────────────
  //
  // `remove()` is a soft delete (the schema declares `deletedAt`), so without these
  // two methods a deleted deal was invisible everywhere and recoverable nowhere —
  // strictly worse than the hard delete it replaced, because the row also stayed in
  // the database forever.

  async listDeleted(options: { page?: number; limit?: number }): Promise<{
    data: Deal[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(100, Math.max(1, options.limit ?? 25));
    const { data, total } = await this.repository.findDeleted({ page, limit });
    return { data, total, page, limit };
  }

  async restore(id: string): Promise<Deal> {
    const restored = await this.repository.restore(id);
    if (!restored) {
      throw new NotFoundException(
        'Deal not found in the recycle bin — it may already have been purged',
      );
    }

    this.entityAudit.emit({
      entity: 'deal',
      entityType: 'DEAL',
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
      entity: 'deal',
      entityType: 'DEAL',
      entityId: id,
      kind: 'updated',
      oldSnapshot: existing ?? {},
      newSnapshot: { _deleted: true } as any,
    });
  }

  /**
   * Get all tickets linked to this deal (via ticket.dealId).
   * Delegates to the tickets endpoint filter rather than a direct repo call
   * to avoid a circular module dependency between Deals ↔ Tickets.
   */
  async getLinkedTickets(
    dealId: string,
  ): Promise<{ data: any[]; total: number }> {
    if (!(await this.repository.findOne({ _id: dealId }))) {
      throw new BusinessException(
        DEAL_ERRORS.NOT_FOUND,
        HttpStatus.NOT_FOUND,
        `Deal ${dealId} not found`,
      );
    }
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

    const filter: any = {
      dealId,
      deletedAt: null,
      ...buildCrmReportVisibilityFilter(this.cls, 'Ticket'),
    };
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
      await this.enrichImportJobRecord(doc as Record<string, any>);
    }
    return { data, total, page, limit };
  }

  private async enrichImportJobRecord(record: Record<string, any>) {
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

  /**
   * Notify the Automation Engine after a successful write.
   *
   * Deal triggers were selectable in the workflow builder but this service
   * never emitted the event, so `record_created.Deal` and
   * `field_updated.Deal` workflows could be authored, published and
   * activated without ever firing. AutomationEventPayload's own docblock claimed
   * this service was an emitter.
   */
  private buildAutomationEvent(
    event: 'record_created' | 'field_updated',
    record: Deal,
    changedFields?: string[],
  ): AutomationEventPayload | null {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    if (!tenantId) {
      throw new Error('Tenant context is required for Deal automation.');
    }

    const payload: AutomationEventPayload = {
      tenantId,
      event,
      object: 'Deal',
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

  /**
   * Stamp the close timestamps and refuse a silent reopen.
   *
   * Deal stages carry tenant-configured `isWon` / `isLost` flags, so the terminal state is
   * a property of the tenant's pipeline rather than a hard-coded status name. (There WAS a
   * `common/state/status-transition.validator.ts` with hard-coded `open/won/lost` maps; it
   * was dead code and would have been wrong here for any tenant with custom stages.)
   *
   * Two things happen on a stage change:
   *
   *   1. Moving INTO a won or lost stage stamps `wonAt` / `lostAt`. Those fields are read
   *      by the assignment workload projection, the record candidate loader and the
   *      stale-deal trigger as the definition of "still open" — and nothing had ever
   *      written them, so a won deal stayed on its owner's workload forever and the stale
   *      trigger kept nagging about deals closed months ago.
   *   2. Moving OUT of one requires `allowReopen: true`, mirroring the ticket guard.
   *      Reopening a won deal changes closed revenue in every report that reads it, so it
   *      should be a deliberate act rather than a drag between two columns. On reopen the
   *      stamps are cleared, or the deal would read as closed to those three systems while
   *      sitting in an open stage.
   */
  private async applyStageTransition(
    existingDeal: Deal | null,
    data: Partial<Deal>,
    updateData: Record<string, any>,
  ): Promise<void> {
    if (!data.stageId) return;

    const previousStageId = (existingDeal as any)?.stageId;
    if (previousStageId && String(previousStageId) === String(data.stageId)) {
      return; // idempotent
    }

    const [previousStage, nextStage] = await Promise.all([
      previousStageId
        ? this.stageModel.findById(String(previousStageId)).lean().exec()
        : Promise.resolve(null),
      this.stageModel.findById(String(data.stageId)).lean().exec(),
    ]);

    const wasClosed = Boolean(
      (previousStage as any)?.isWon || (previousStage as any)?.isLost,
    );
    const isClosed = Boolean(
      (nextStage as any)?.isWon || (nextStage as any)?.isLost,
    );

    if (wasClosed && !isClosed) {
      if ((data as any).allowReopen !== true) {
        // DEAL_ALREADY_WON / DEAL_ALREADY_LOST existed in DEAL_ERRORS with no emitter,
        // which is why they were flagged as dead. This guard (§38) is exactly the
        // condition they describe, and the code is what lets the client localise the
        // message and offer "reopen anyway" instead of surfacing English prose.
        throw new BusinessException(
          (previousStage as any)?.isWon
            ? DEAL_ERRORS.ALREADY_WON
            : DEAL_ERRORS.ALREADY_LOST,
          HttpStatus.BAD_REQUEST,
          `Deal is in a closed stage ("${(previousStage as any)?.name ?? previousStageId}"). ` +
            'Reopening requires allowReopen=true.',
        );
      }
      // Clear both, not just the one that was set: a deal that went won → lost → open
      // would otherwise keep the older stamp.
      updateData.wonAt = null;
      updateData.lostAt = null;
      return;
    }

    if (isClosed) {
      const now = new Date();
      if ((nextStage as any)?.isWon) {
        updateData.wonAt = (existingDeal as any)?.wonAt ?? now;
        updateData.lostAt = null;
      } else {
        updateData.lostAt = (existingDeal as any)?.lostAt ?? now;
        updateData.wonAt = null;
      }
    }
  }
}
