import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { UserSchemaClass } from '../users/infrastructure/persistence/document/entities/user.schema';
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
import { AuthorizationService } from '../common/permissions/authorization.service';

/**
 * Opaque cursor for `findAllCursor` — base64 JSON of the `(createdAt, _id)`
 * keyset position. Opaque so the query-string shape isn't a public contract
 * a caller could hand-construct or come to depend on.
 */
function encodeDealCursor(
  cursor: { createdAt: string; id: string } | null,
): string | null {
  if (!cursor) return null;
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeDealCursor(
  raw: unknown,
): { createdAt: string; id: string } | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      parsed &&
      typeof parsed.createdAt === 'string' &&
      typeof parsed.id === 'string'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null; // malformed cursor — treat as "start from the beginning"
  }
}
import { ObjectAclService } from '../common/permissions/object-acl.service';
import { RecordWriteValidator } from '../object-manager/validation/record-write-validator.service';
import { BulkUpdateDealsDto, BulkDealResult } from './dto/bulk-deal.dto';

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
    // Validates ownerId on create/update actually resolves to a real, active,
    // same-tenant user rather than accepting any syntactically-valid ObjectId.
    @InjectModel(UserSchemaClass.name)
    private readonly userModel: Model<any>,
    private readonly exportRequest: ExportRequestService,
    private readonly crmSettings: CrmSettingsService,
    private readonly tagsService: TagsService,
    private readonly authorization: AuthorizationService,
    private readonly objectAcl: ObjectAclService,
    private readonly writeValidator: RecordWriteValidator,
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

    // Unlike create/update/remove/restore, this bulk path never emitted an
    // audit entry — tagging up to DEAL_MAX_BULK_TAG_SIZE deals in one call
    // left a gap in the history for exactly the operation an admin is most
    // likely to ask "who did this?" about.
    for (const dealId of dealIds) {
      this.entityAudit.emit({
        entity: 'deal',
        entityType: 'DEAL',
        entityId: dealId,
        kind: 'updated',
        oldSnapshot: {},
        newSnapshot: { tagsAdded: tags },
      });
    }

    return {
      success: true,
      ...result,
    };
  }

  // BULK UPDATE / DELETE
  //
  // The three bulk dialogs in the UI (assign owner, change stage, delete) had
  // no server-side bulk endpoint to call — only bulk-tag existed — so each
  // fell back to `Promise.all(ids.map(singleCall))`, which rejects on the
  // first failure while the rest may have already applied, with no way for
  // the caller to learn which ids succeeded.
  //
  // Both methods below loop over `update()` / `remove()` rather than issuing
  // one `bulkWrite`, mirroring the Tasks module: a single `bulkWrite` would
  // bypass the visibility scope check, the close-state guards, the audit
  // entry per record and the automation event per record. The id cap is what
  // keeps the loop bounded.

  async bulkUpdate(dto: BulkUpdateDealsDto): Promise<BulkDealResult> {
    const { ids, ...changes } = dto;
    const result: BulkDealResult = { updated: 0, skipped: [] };

    if (Object.keys(changes).length === 0) {
      throw new UnprocessableEntityException({
        status: 422,
        errors: { changes: 'At least one field to update is required.' },
      });
    }

    for (const id of ids) {
      try {
        await this.update(id, changes as Partial<Deal>);
        result.updated++;
      } catch (error) {
        result.skipped.push({ id, reason: this.describeBulkSkip(error) });
      }
    }

    return result;
  }

  async bulkRemove(ids: string[]): Promise<BulkDealResult> {
    const result: BulkDealResult = { updated: 0, skipped: [] };

    for (const id of ids) {
      try {
        await this.remove(id);
        result.updated++;
      } catch (error) {
        result.skipped.push({ id, reason: this.describeBulkSkip(error) });
      }
    }

    return result;
  }

  /**
   * Why one id in a bulk operation was not applied. A 404 is reported as a
   * scope miss rather than "not found" — from the caller's side those are the
   * same fact, and the distinction is exactly what a scoped user is not
   * entitled to learn.
   */
  private describeBulkSkip(error: unknown): string {
    if (error instanceof NotFoundException) {
      return 'Not found, or outside your access scope.';
    }
    if (error instanceof ConflictException) {
      return 'Changed by someone else — please reload.';
    }
    if (error instanceof ForbiddenException) {
      return 'You do not have permission to change this field.';
    }
    if (error instanceof BusinessException) {
      return error.message;
    }
    if (error instanceof UnprocessableEntityException) {
      const response = error.getResponse() as {
        errors?: Record<string, string>;
      };
      const first = response?.errors
        ? Object.values(response.errors)[0]
        : undefined;
      return first ?? 'Invalid.';
    }
    // Anything else is a real fault, not a per-record outcome, so it is
    // logged rather than folded into a tidy summary.
    this.logger.error(
      `Bulk deal operation failed unexpectedly: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error instanceof Error ? error.stack : undefined,
    );
    return 'Unexpected error.';
  }

  // Helpers

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

  /**
   * Reject an ownerId that doesn't resolve to a real, active, same-tenant
   * user. A syntactically-valid but nonexistent ObjectId used to be accepted
   * silently, only surfacing later as a null owner-populate on read.
   */
  private async assertOwnerExists(ownerId: string | undefined): Promise<void> {
    if (!ownerId) return;
    const tenantId = this.resolveTenantId();
    const owner = await this.userModel
      .findOne({ _id: ownerId, tenantId, deletedAt: null } as any)
      .select({ _id: 1 })
      .lean()
      .exec();
    if (!owner) {
      throw new BusinessException(
        DEAL_ERRORS.INVALID_OWNER,
        HttpStatus.BAD_REQUEST,
        `ownerId ${ownerId} does not refer to an active user in this tenant.`,
      );
    }
  }

  /**
   * Reassigning ownerId separately from a plain field edit. Ownership is the
   * primary visibility axis for deals (same reasoning as contacts:assign) —
   * without this, anyone holding base `deals:edit` could silently move a
   * deal into their own pipeline or a colleague's, indistinguishable in the
   * audit trail from correcting the title.
   *
   * Unconditional, matching the contacts precedent: a feature flag here would
   * be fail-open security, bypassable by any API caller in a tenant that
   * hadn't explicitly turned enforcement on.
   */
  private async assertMayTransferOwnership(
    existing: Deal | null,
    nextOwnerId: string | undefined,
  ): Promise<void> {
    if (nextOwnerId === undefined) return; // not present in the patch at all
    const userId = this.getCurrentUserId();
    if (existing) {
      if (String(existing.ownerId ?? '') === String(nextOwnerId ?? '')) return; // unchanged
    } else if (String(nextOwnerId) === String(userId ?? '')) {
      return; // creating for yourself is not a transfer
    }
    const decision = await this.authorization.canPerformAction({
      rule: { action: 'assign', resource: 'deals' },
      rawUserId: String(userId ?? ''),
      tenantHint: this.resolveTenantId(),
    });
    if (!decision.allowed) {
      throw new ForbiddenException(
        'Changing the owner of a deal requires the deals:assign permission.',
      );
    }
  }

  /**
   * Warn on an obvious double-submit or duplicate create — same title, same
   * account, still open — rather than silently allowing an unlimited number
   * of identical deals. Not a hard uniqueness constraint (titles legitimately
   * repeat across accounts/years): callers can proceed anyway with
   * `allowDuplicate: true`.
   */
  private async checkDuplicate(data: Record<string, any>): Promise<void> {
    if ((data as any).allowDuplicate === true) return;
    const title = data.title;
    if (!title) return;
    const tenantId = this.resolveTenantId();
    const match: Record<string, any> = {
      tenantId,
      title,
      deletedAt: null,
    };
    if (data.accountId) match.accountId = data.accountId;
    const existing = await (this.repository as any).model
      .findOne(match)
      .select({ _id: 1 })
      .lean()
      .exec();
    if (existing) {
      throw new BusinessException(
        DEAL_ERRORS.POSSIBLE_DUPLICATE,
        HttpStatus.CONFLICT,
        `A deal titled "${title}" already exists${data.accountId ? ' for this account' : ''}. Pass allowDuplicate=true to create it anyway.`,
      );
    }
  }

  async create(data: Partial<Deal>): Promise<Deal> {
    this.cleanRefs(data as Record<string, any>);
    await this.writeValidator.assertValid(
      'Deal',
      data as unknown as Record<string, unknown>,
      'create',
    );
    await this.assertOwnerExists((data as any).ownerId);
    await this.assertMayTransferOwnership(null, (data as any).ownerId);
    await this.checkDuplicate(data as Record<string, any>);

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
    const filterOptions = await this.buildFilterOptions(filter);
    return this.repository.findManyWithPagination({
      filterOptions,
      paginationOptions: {
        page: Number(filter.page) || 1,
        limit: Number(filter.limit) || 10,
      },
    });
  }

  /**
   * Keyset-pagination sibling of `findAll` — see
   * `DealRepository.findManyByCursor` for why this exists. Additive: `GET
   * /deals` and its contract are untouched; a caller opts in via `GET
   * /deals/list-cursor`.
   */
  async findAllCursor(filter: any): Promise<{
    data: Deal[];
    nextCursor: string | null;
  }> {
    const filterOptions = await this.buildFilterOptions(filter);
    const limit = Math.min(200, Math.max(1, Number(filter.limit) || 25));
    const cursor = decodeDealCursor(filter.cursor);

    const { data, nextCursor } = await this.repository.findManyByCursor({
      filterOptions,
      cursor,
      limit,
    });

    return { data, nextCursor: encodeDealCursor(nextCursor) };
  }

  private async buildFilterOptions(filter: any): Promise<Record<string, any>> {
    // Object-ACL denies are enforced on the single-record route (@UseAcl +
    // @LoadResource) but a collection route has no `:id` to narrow to, so a
    // deal an admin explicitly denied one user access to still showed up in
    // that user's list — only opening it directly was blocked. Excluding
    // denied ids here closes that list-vs-detail inconsistency.
    const excludeIds = await this.resolveAclDeniedDealIds();

    return {
      ...filter,
      ...(excludeIds.length ? { __excludeIds: excludeIds } : {}),
      __customFieldDefinitions: await loadCustomFieldDefinitions(
        this.customFields,
        'Deal',
        filter.filters,
      ),
    };
  }

  private async resolveAclDeniedDealIds(): Promise<string[]> {
    const tenantId = this.resolveTenantId();
    const userId = this.getCurrentUserId();
    if (!tenantId || !userId) return [];
    const groupIds = this.cls.get<string[]>('visibleGroupIds') ?? [];
    try {
      return await this.objectAcl.getDeniedResourceIds(
        tenantId,
        [String(userId), ...groupIds],
        'deals',
        'view',
      );
    } catch (err) {
      this.logger.warn(
        `Could not resolve object-ACL denies for deals list: ${(err as Error).message}`,
      );
      return []; // fail open on the LOOKUP only — a missing exclusion list still leaves the resource-level grant in force, same as today
    }
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
    await this.writeValidator.assertValid(
      'Deal',
      data as unknown as Record<string, unknown>,
      'update',
    );
    if ((data as any).ownerId !== undefined) {
      await this.assertOwnerExists((data as any).ownerId);
      // A fresh assignment clears the "owner left the tenant" marker —
      // otherwise a re-assigned deal would still show as unassigned-by-cleanup.
      (data as any).unassignedReason = null;
    }
    await this.assertMayTransferOwnership(existingDeal, (data as any).ownerId);

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

  // RECYCLE BIN
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
  // DEAL IMPORT

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
    // wonAt/lostAt are server-computed only. They used to be independently
    // patchable DTO fields, which let a caller flip a deal's closed/open
    // read (as seen by the workload projection and stale-deal trigger)
    // without ever touching stageId — completely bypassing the guard below.
    delete (data as any).wonAt;
    delete (data as any).lostAt;

    const touchesClosedSensitiveField =
      data.stageId !== undefined ||
      (data as any).value !== undefined ||
      (data as any).currency !== undefined;
    if (!touchesClosedSensitiveField) return;

    const previousStageId = (existingDeal as any)?.stageId;
    const previousStage = previousStageId
      ? await this.stageModel.findById(String(previousStageId)).lean().exec()
      : null;
    const wasWon = Boolean((previousStage as any)?.isWon);
    const wasLost = Boolean((previousStage as any)?.isLost);
    // A stage deleted out from under a closed deal must not silently read as
    // "never closed" — fall back to the deal's own stamps rather than trusting
    // a lookup miss (the previous fail-open let a deal with a deleted won
    // stage skip the reopen guard entirely).
    const wasClosed =
      wasWon ||
      wasLost ||
      Boolean((existingDeal as any)?.wonAt) ||
      Boolean((existingDeal as any)?.lostAt);

    const isStageChange =
      data.stageId !== undefined &&
      !(previousStageId && String(previousStageId) === String(data.stageId));

    if (!isStageChange) {
      // No stage change: block rewriting a closed deal's economics (the
      // figure every past revenue report already summed) unless the caller
      // explicitly acknowledges it via the same allowReopen flag.
      if (
        wasClosed &&
        ((data as any).value !== undefined ||
          (data as any).currency !== undefined) &&
        (data as any).allowReopen !== true
      ) {
        throw new BusinessException(
          wasWon ? DEAL_ERRORS.ALREADY_WON : DEAL_ERRORS.ALREADY_LOST,
          HttpStatus.BAD_REQUEST,
          'Deal is closed. Amount/currency cannot be changed without allowReopen=true.',
        );
      }
      return; // idempotent stage patch, or an edit unrelated to close state
    }

    const nextStage = await this.stageModel
      .findById(String(data.stageId))
      .lean()
      .exec();
    const nextWon = Boolean((nextStage as any)?.isWon);
    const nextLost = Boolean((nextStage as any)?.isLost);
    const isClosed = nextWon || nextLost;
    // Covers both "closed → open" (reopen) and "Won → Lost" / "Lost → Won"
    // (both read as `isClosed`, so the old `wasClosed && !isClosed` guard
    // never fired for a same-closed-ness flip that reverses recognized
    // revenue in one call).
    const classificationChanged = wasWon !== nextWon || wasLost !== nextLost;

    if (wasClosed && classificationChanged) {
      if ((data as any).allowReopen !== true) {
        // DEAL_ALREADY_WON / DEAL_ALREADY_LOST existed in DEAL_ERRORS with no emitter,
        // which is why they were flagged as dead. This guard (§38) is exactly the
        // condition they describe, and the code is what lets the client localise the
        // message and offer "reopen anyway" instead of surfacing English prose.
        throw new BusinessException(
          wasWon ? DEAL_ERRORS.ALREADY_WON : DEAL_ERRORS.ALREADY_LOST,
          HttpStatus.BAD_REQUEST,
          `Deal is in a closed stage ("${(previousStage as any)?.name ?? previousStageId}"). ` +
            'Reopening or reclassifying (Won ↔ Lost) requires allowReopen=true.',
        );
      }
      // Clear both, not just the one that was set: a deal that went won → lost → open
      // would otherwise keep the older stamp.
      updateData.wonAt = null;
      updateData.lostAt = null;
    }

    if (isClosed) {
      if (
        nextLost &&
        !((data as any).lostReason || (existingDeal as any)?.lostReason)
      ) {
        throw new UnprocessableEntityException({
          status: 422,
          errors: {
            lostReason: 'lostReason is required to close a deal as Lost',
          },
        });
      }
      const now = new Date();
      if (nextWon) {
        updateData.wonAt = (existingDeal as any)?.wonAt ?? now;
        updateData.lostAt = null;
      } else {
        updateData.lostAt = (existingDeal as any)?.lostAt ?? now;
        updateData.wonAt = null;
      }
    }
  }
}
