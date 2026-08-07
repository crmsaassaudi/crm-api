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
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ClientSession, Model } from 'mongoose';
import { Readable } from 'stream';
import { ClsService } from 'nestjs-cls';

import { BusinessException } from '../common/exceptions/business.exception';
import { DEAL_ERRORS } from './constants/deal-error-codes';
import {
  DealBoardColumn,
  DealCursor,
  DealRepository,
} from './infrastructure/persistence/document/repositories/deal.repository';
import { UserSchemaClass } from '../users/infrastructure/persistence/document/entities/user.schema';
import { TicketSchemaClass } from '../tickets/infrastructure/persistence/document/entities/ticket.schema';
import { Deal } from './domain/deal';
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
import { TagsService } from '../tags/tags.service';
import { buildCrmReportVisibilityFilter } from '../reports/shared/utils/report-visibility-filter.util';
import { CustomFieldValueValidator } from '../custom-fields/custom-field-value.validator';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { loadCustomFieldDefinitions } from '../utils/custom-field-filter';
import { AuthorizationService } from '../common/permissions/authorization.service';
import { PermissionAction } from '../common/permissions/permission.constants';
import { ObjectAclService } from '../common/permissions/object-acl.service';
import { RecordWriteValidator } from '../object-manager/validation/record-write-validator.service';
import { BulkUpdateDealsDto, BulkDealResult } from './dto/bulk-deal.dto';
import { DealSettingsService } from '../deal-settings/deal-settings.service';
import { DealRulesService } from './deal-rules.service';

/**
 * Opaque cursor for the keyset list and the board columns — base64 JSON of the
 * `(createdAt, _id)` position. Opaque so the query-string shape is not a public
 * contract a caller could hand-construct.
 */
const encodeCursor = (cursor: DealCursor | null): string | null =>
  cursor
    ? Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
    : null;

const decodeCursor = (raw: unknown): DealCursor | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return typeof parsed?.createdAt === 'string' &&
      typeof parsed?.id === 'string'
      ? { createdAt: parsed.createdAt, id: parsed.id }
      : null;
  } catch {
    return null; // malformed cursor — start from the beginning
  }
};

/** ObjectId refs an empty-string form value must not reach Mongoose's cast as `''`. */
const OBJECT_ID_FIELDS = [
  'accountId',
  'ownerId',
  'sourceId',
  'stageId',
  'pipelineId',
  'omniConversationId',
] as const;

@Injectable()
export class DealsService {
  private readonly logger = new Logger(DealsService.name);
  private readonly importStorage: ImportStorageService;

  constructor(
    private readonly repository: DealRepository,
    private readonly dealSettings: DealSettingsService,
    private readonly dealRules: DealRulesService,
    // Enforces the tenant's custom_fields registry on the Mixed `customFields`
    // column, which otherwise accepted any key of any shape.
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
    // Validates ownerId on create/update actually resolves to a real, active,
    // same-tenant user rather than accepting any syntactically-valid ObjectId.
    @InjectModel(UserSchemaClass.name)
    private readonly userModel: Model<any>,
    @InjectModel(TicketSchemaClass.name)
    private readonly ticketModel: Model<any>,
    private readonly exportRequest: ExportRequestService,
    private readonly tagsService: TagsService,
    private readonly authorization: AuthorizationService,
    private readonly objectAcl: ObjectAclService,
    private readonly writeValidator: RecordWriteValidator,
    @Optional() private readonly customFields?: CustomFieldsService,
  ) {
    this.importStorage = this.storageFactory.create('deals');
  }

  // Context helpers

  private getCurrentUserId(): string | undefined {
    return this.cls.get('userId') ?? this.cls.get('user.id');
  }

  private resolveTenantId(): string {
    return this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
  }

  /** Convert empty-string ObjectId refs to undefined in place. */
  private cleanRefs(data: Record<string, unknown>): void {
    for (const key of OBJECT_ID_FIELDS) {
      if (data[key] === '') data[key] = undefined;
    }
  }

  // Create

  async create(data: Partial<Deal>): Promise<Deal> {
    const payload = data as Record<string, any>;
    this.cleanRefs(payload);

    await this.writeValidator.assertValid('Deal', payload, 'create');
    await this.assertOwnerExists(payload.ownerId);
    await this.assertMayTransferOwnership(null, payload.ownerId);
    await this.assertNoDuplicate(payload);

    // One call decides the pipeline, the stage and their consistency. Both were
    // schema-required with no server-side default, so a create that omitted
    // either — which is what both web forms did — died on a Mongoose validation
    // error instead of landing in the tenant's default pipeline.
    const placement = await this.dealSettings.resolvePlacement({
      pipelineId: payload.pipelineId,
      stageId: payload.stageId,
    });

    if (placement.isWon || placement.isLost) {
      throw new BadRequestException(
        'A deal cannot be created directly in a closed stage. Create it open, then close it.',
      );
    }

    const customFields = await this.customFieldValidator.validate(
      'Deal',
      data.customFields,
    );

    const now = new Date();
    const userId = this.getCurrentUserId() ?? null;
    const rules = await this.dealRules.get();
    const document = {
      ...payload,
      pipelineId: placement.pipelineId,
      stageId: placement.stageId,
      probability: payload.probability ?? placement.probability,
      ownerAssignedExplicitly: Boolean(payload.ownerId),
      // Every new deal enters the follow-up queue by default: a queue reps have
      // to remember to opt into is a queue that stays empty while leads go cold.
      nextFollowUpAt:
        payload.nextFollowUpAt ??
        (rules.followUpDefaultOffsetHours > 0
          ? new Date(
              now.getTime() + rules.followUpDefaultOffsetHours * 3_600_000,
            )
          : null),
      stageEnteredAt: now,
      lastActivityAt: now,
      stageHistory: [
        {
          fromStageId: null,
          toStageId: placement.stageId,
          changedAt: now,
          changedById: userId,
          durationMs: null,
        },
      ],
      ...(customFields !== undefined ? { customFields } : {}),
    };

    const deal = await this.automationOutbox.runWithEvent(
      (session) => this.repository.create(document as any, session),
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

  /**
   * Refuse an obvious double-submit: same title, same account, still open.
   *
   * Not a uniqueness constraint (titles legitimately repeat across accounts and
   * years) — callers proceed with `allowDuplicate: true`. Scoped to the tenant
   * but deliberately not to the caller's visibility: the alternative is letting
   * two reps each create the same deal because neither can see the other's.
   */
  private async assertNoDuplicate(data: Record<string, any>): Promise<void> {
    if (data.allowDuplicate === true || !data.title) return;

    const exists = await this.repository.existsOpenDuplicate({
      title: data.title,
      accountId: data.accountId,
    });
    if (exists) {
      throw new BusinessException(
        DEAL_ERRORS.POSSIBLE_DUPLICATE,
        HttpStatus.CONFLICT,
        `An open deal titled "${data.title}" already exists. Pass allowDuplicate=true to create it anyway.`,
      );
    }
  }

  private async assertOwnerExists(ownerId?: string): Promise<void> {
    if (!ownerId) return;
    const owner = await this.userModel
      .findOne({
        _id: ownerId,
        tenantId: this.resolveTenantId(),
        deletedAt: null,
      })
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
   * Reassigning ownership is its own capability.
   *
   * Ownership is the primary visibility axis for deals, so without this anyone
   * holding base `deals:edit` could move a deal into their own pipeline,
   * indistinguishable in the audit trail from correcting the title.
   */
  private async assertMayTransferOwnership(
    existing: Deal | null,
    nextOwnerId: string | undefined,
  ): Promise<void> {
    if (nextOwnerId === undefined) return;
    const userId = this.getCurrentUserId();

    if (existing) {
      if (String(existing.ownerId ?? '') === String(nextOwnerId ?? '')) return;
    } else if (String(nextOwnerId) === String(userId ?? '')) {
      return; // creating for yourself is not a transfer
    }

    await this.assertPermission(
      'assign',
      'Changing the owner of a deal requires the deals:assign permission.',
    );
  }

  private async assertPermission(
    action: PermissionAction,
    message: string,
  ): Promise<void> {
    const decision = await this.authorization.canPerformAction({
      rule: { action, resource: 'deals' },
      rawUserId: String(this.getCurrentUserId() ?? ''),
      tenantHint: this.resolveTenantId(),
    });
    if (!decision.allowed) throw new ForbiddenException(message);
  }

  // Read

  async findAll(filter: any): Promise<any> {
    return this.repository.findManyWithPagination({
      filterOptions: await this.buildFilterOptions(filter),
      paginationOptions: {
        page: Number(filter.page) || 1,
        limit: Math.min(200, Math.max(1, Number(filter.limit) || 10)),
      },
    });
  }

  async findAllCursor(
    filter: any,
  ): Promise<{ data: Deal[]; nextCursor: string | null }> {
    const { data, nextCursor } = await this.repository.findManyByCursor({
      filterOptions: await this.buildFilterOptions(filter),
      cursor: decodeCursor(filter.cursor),
      limit: Math.min(200, Math.max(1, Number(filter.limit) || 25)),
    });
    return { data, nextCursor: encodeCursor(nextCursor) };
  }

  /**
   * Column headers for the Kanban board: one row per stage, counted and summed
   * by the database under the caller's own visibility scope.
   *
   * The board used to compute both in the browser from whichever page of deals
   * happened to be loaded, so the numbers a manager steers by were the numbers
   * of the first fifty rows.
   */
  async getBoardSummary(filter: {
    pipelineId?: string;
    search?: string;
    filters?: unknown;
    ownerId?: string;
    followUp?: string;
  }): Promise<{ pipelineId: string; columns: DealBoardColumn[] }> {
    const placement = await this.dealSettings.resolvePlacement({
      pipelineId: filter.pipelineId,
    });
    const columns = await this.repository.boardSummary(
      await this.buildFilterOptions({
        ...filter,
        pipelineId: placement.pipelineId,
      }),
    );
    return { pipelineId: placement.pipelineId, columns };
  }

  /** One board column, keyset-paginated so a busy stage scrolls instead of loading whole. */
  async getBoardColumn(filter: {
    pipelineId?: string;
    stageId: string;
    cursor?: string;
    limit?: number;
    search?: string;
    filters?: unknown;
    ownerId?: string;
    followUp?: string;
  }): Promise<{ data: Deal[]; nextCursor: string | null }> {
    const { data, nextCursor } = await this.repository.findManyByCursor({
      filterOptions: await this.buildFilterOptions(filter),
      cursor: decodeCursor(filter.cursor),
      limit: Math.min(100, Math.max(1, Number(filter.limit) || 25)),
    });
    return { data, nextCursor: encodeCursor(nextCursor) };
  }

  private async buildFilterOptions(filter: any): Promise<Record<string, any>> {
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
      // Fail open on the LOOKUP only — the resource-level grant is still in force.
      this.logger.warn(
        `Could not resolve object-ACL denies for deals list: ${(err as Error).message}`,
      );
      return [];
    }
  }

  findOne(id: string): Promise<Deal | null> {
    return this.repository.findOne({ _id: id });
  }

  // Update

  async update(id: string, data: Partial<Deal>): Promise<Deal | null> {
    const existing = await this.repository.findOne({ _id: id });
    // `findOne` is scoped by tenant, data-visibility and the ABAC deny, so a miss
    // means "not yours to edit". Refusing here keeps the answer a 404 and skips
    // validation work a denied request should never pay for.
    if (!existing) throw new NotFoundException(`Deal ${id} not found`);

    const payload = data as Record<string, any>;
    this.cleanRefs(payload);

    // Server-computed. They used to be independently patchable, which let a
    // caller flip a deal's closed/open reading without touching `stageId`.
    delete payload.wonAt;
    delete payload.lostAt;
    delete payload.stageEnteredAt;
    delete payload.lastActivityAt;
    delete payload.ownerAssignedExplicitly;

    await this.writeValidator.assertValid('Deal', payload, 'update');

    if (payload.ownerId !== undefined) {
      await this.assertOwnerExists(payload.ownerId);
      // A fresh assignment clears the "owner left the tenant" marker and records
      // that a human, not the create default, chose this owner.
      payload.unassignedReason = null;
      payload.ownerAssignedExplicitly = true;
    }
    await this.assertMayTransferOwnership(existing, payload.ownerId);

    // Rescheduling a follow-up re-arms the sweep. Without this the notice for the
    // new date never fires, because the deal is still marked as announced.
    if (payload.nextFollowUpAt !== undefined) {
      payload.followUpNotifiedAt = null;
    }

    // `partial: true` — a PATCH that does not mention a required custom field
    // must not fail on it; it was satisfied at create time.
    const customFields = await this.customFieldValidator.validate(
      'Deal',
      data.customFields,
      { partial: true },
    );

    const transition = await this.applyStageTransition(existing, payload);
    const changedFields = Object.keys(payload);

    const updated = await this.automationOutbox.runWithEvent(
      async (session) => {
        const result = await this.repository.update(
          id,
          {
            ...payload,
            ...(customFields !== undefined ? { customFields } : {}),
            ...transition.updates,
            lastActivityAt: new Date(),
          } as any,
          session,
        );
        if (transition.historyEntry) {
          await this.repository.appendStageHistory(
            id,
            transition.historyEntry,
            session,
          );
        }
        return result;
      },
      (result) =>
        result
          ? this.buildAutomationEvent('field_updated', result, changedFields)
          : null,
    );

    if (updated) {
      this.entityAudit.emit({
        entity: 'deal',
        entityType: 'DEAL',
        entityId: id,
        kind: 'updated',
        oldSnapshot: existing,
        newSnapshot: updated,
      });
    }

    return updated;
  }

  /**
   * Stage moves: validate the target, stamp the close timestamps, refuse a silent
   * reopen, and record the transition.
   *
   * Terminal state is a property of the tenant's pipeline (`isWon`/`isLost` on
   * the stage), not a hard-coded status name — the flags are what the workload
   * projection, the stale-deal trigger and every revenue report read as "still
   * open".
   */
  private async applyStageTransition(
    existing: Deal,
    data: Record<string, any>,
  ): Promise<{
    updates: Record<string, any>;
    historyEntry: {
      fromStageId: string | null;
      toStageId: string;
      changedAt: Date;
      changedById: string | null;
      durationMs: number | null;
    } | null;
  }> {
    const updates: Record<string, any> = {};
    const touchesEconomics =
      data.value !== undefined || data.currency !== undefined;
    const wantsMove =
      (data.stageId !== undefined &&
        String(data.stageId) !== String(existing.stageId)) ||
      (data.pipelineId !== undefined &&
        String(data.pipelineId) !== String(existing.pipelineId));

    if (!wantsMove && !touchesEconomics) {
      // Nothing close-state sensitive. Drop a redundant stage echo so it cannot
      // reset `stageEnteredAt` or append a no-op history entry.
      delete data.stageId;
      delete data.pipelineId;
      return { updates, historyEntry: null };
    }

    const previous = await this.dealSettings.describeStage(existing.stageId);
    // A stage deleted out from under a closed deal must not read as "never
    // closed": fall back to the deal's own stamps rather than trusting a miss.
    const wasWon = Boolean(previous?.isWon) || Boolean(existing.wonAt);
    const wasLost = Boolean(previous?.isLost) || Boolean(existing.lostAt);
    const wasClosed = wasWon || wasLost;

    if (!wantsMove) {
      if (wasClosed && data.allowReopen !== true) {
        throw new BusinessException(
          wasWon ? DEAL_ERRORS.ALREADY_WON : DEAL_ERRORS.ALREADY_LOST,
          HttpStatus.BAD_REQUEST,
          'Deal is closed. Amount and currency cannot be changed without allowReopen=true.',
        );
      }
      return { updates, historyEntry: null };
    }

    await this.assertPermission(
      'move_stage',
      'Moving a deal between stages requires the deals:move_stage permission.',
    );

    const target = await this.dealSettings.resolvePlacement({
      pipelineId: data.pipelineId ?? existing.pipelineId,
      stageId: data.stageId ?? undefined,
    });
    data.pipelineId = target.pipelineId;
    data.stageId = target.stageId;

    const isClosed = target.isWon || target.isLost;
    // Covers reopen (closed → open) and reclassification (Won ⇄ Lost), which
    // reverses recognised revenue in one call and reads as "still closed".
    const classificationChanged =
      wasWon !== target.isWon || wasLost !== target.isLost;

    if (wasClosed && classificationChanged) {
      if (data.allowReopen !== true) {
        throw new BusinessException(
          wasWon ? DEAL_ERRORS.ALREADY_WON : DEAL_ERRORS.ALREADY_LOST,
          HttpStatus.BAD_REQUEST,
          'Deal is in a closed stage. Reopening or reclassifying (Won ⇄ Lost) requires allowReopen=true.',
        );
      }
      // Clear both: a deal that went won → lost → open would otherwise keep the
      // older stamp and still read as closed to the workload projection.
      updates.wonAt = null;
      updates.lostAt = null;
    }

    if (target.isWon) await this.assertWinRequirementsMet(existing, data);
    if (target.isLost && !(data.lostReason || existing.lostReason)) {
      throw new UnprocessableEntityException({
        status: 422,
        errors: { lostReason: 'A reason is required to close a deal as Lost.' },
      });
    }

    const now = new Date();
    if (isClosed) {
      if (target.isWon) {
        updates.wonAt = existing.wonAt ?? now;
        updates.lostAt = null;
      } else {
        updates.lostAt = existing.lostAt ?? now;
        updates.wonAt = null;
      }
      // A closed deal owes nobody a call; leaving the commitment behind would
      // keep won deals in every rep's overdue queue forever.
      updates.nextFollowUpAt = null;
      updates.followUpNotifiedAt = null;
    }

    updates.stageEnteredAt = now;
    updates.probability = data.probability ?? target.probability;

    const enteredAt = existing.stageEnteredAt
      ? new Date(existing.stageEnteredAt).getTime()
      : null;

    return {
      updates,
      historyEntry: {
        fromStageId: existing.stageId ?? null,
        toStageId: target.stageId,
        changedAt: now,
        changedById: this.getCurrentUserId() ?? null,
        durationMs: enteredAt ? now.getTime() - enteredAt : null,
      },
    };
  }

  /**
   * What must be true before a deal counts as revenue.
   *
   * Won deals feed forecast, commission and every board a manager reports
   * upward, so the fields those figures depend on are checked at the moment the
   * deal becomes one — the only moment a rep is guaranteed to be looking.
   */
  private async assertWinRequirementsMet(
    existing: Deal,
    data: Record<string, any>,
  ): Promise<void> {
    const rules = await this.dealRules.get();
    const merged = { ...existing, ...data } as Record<string, any>;
    const errors: Record<string, string> = {};

    if (rules.requireValueOnWin && !(Number(merged.value) > 0)) {
      errors.value = 'A won deal must have an amount greater than zero.';
    }
    if (rules.requireOwnerOnWin && !merged.ownerId) {
      errors.ownerId = 'A won deal must have an owner.';
    }
    if (rules.requireContactOnWin && !(merged.contactIds?.length > 0)) {
      errors.contactIds = 'A won deal must be linked to at least one contact.';
    }
    if (rules.requireCloseDateOnWin && !merged.closeDate) {
      errors.closeDate = 'A won deal must have a close date.';
    }

    if (Object.keys(errors).length > 0) {
      throw new UnprocessableEntityException({ status: 422, errors });
    }
  }

  // Bulk
  //
  // Both loop over `update()` / `remove()` rather than issuing one `bulkWrite`:
  // a bulkWrite would bypass the visibility scope, the close-state guards, the
  // audit entry per record and the automation event per record. The id cap is
  // what keeps the loop bounded.

  async bulkUpdate(dto: BulkUpdateDealsDto): Promise<BulkDealResult> {
    const { ids, ...changes } = dto;
    if (Object.keys(changes).length === 0) {
      throw new UnprocessableEntityException({
        status: 422,
        errors: { changes: 'At least one field to update is required.' },
      });
    }

    const result: BulkDealResult = { updated: 0, skipped: [] };
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

  async bulkTagDeals(params: {
    dealIds: string[];
    tags: string[];
  }): Promise<{ success: true; matchedCount: number; modifiedCount: number }> {
    const dealIds = [...new Set(params.dealIds ?? [])].filter(Boolean);
    const tags = [
      ...new Set((params.tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
    ];

    if (dealIds.length === 0)
      throw new BadRequestException('dealIds is required');
    if (tags.length === 0) throw new BadRequestException('tags is required');
    if (dealIds.length > DEAL_MAX_BULK_TAG_SIZE) {
      throw new BadRequestException(
        `Bulk operation exceeds the maximum of ${DEAL_MAX_BULK_TAG_SIZE} deals per request.`,
      );
    }

    await this.tagsService.validateTagIds('Deal', tags);
    const result = await this.repository.addTagsToDeals(dealIds, tags);

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

    return { success: true, ...result };
  }

  /**
   * Why one id in a bulk operation was not applied. A 404 is reported as a scope
   * miss rather than "not found" — from the caller's side those are the same
   * fact, and the distinction is what a scoped user is not entitled to learn.
   */
  private describeBulkSkip(error: unknown): string {
    if (error instanceof NotFoundException) {
      return 'Not found, or outside your access scope.';
    }
    if (error instanceof ConflictException) {
      return 'Changed by someone else — please reload.';
    }
    if (error instanceof ForbiddenException) {
      return 'You do not have permission to make this change.';
    }
    if (error instanceof BusinessException) return error.message;
    if (error instanceof UnprocessableEntityException) {
      const response = error.getResponse() as {
        errors?: Record<string, string>;
      };
      return Object.values(response?.errors ?? {})[0] ?? 'Invalid.';
    }
    // Anything else is a real fault, not a per-record outcome.
    this.logger.error(
      `Bulk deal operation failed unexpectedly: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error instanceof Error ? error.stack : undefined,
    );
    return 'Unexpected error.';
  }

  // Recycle bin

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
        'Deal not found in the recycle bin — it may already have been purged.',
      );
    }

    this.entityAudit.emit({
      entity: 'deal',
      entityType: 'DEAL',
      entityId: id,
      // `updated`, not `restored`: AuditLogListener subscribes to `deal.updated`
      // only, so any other kind would emit an event nothing records.
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
      // See `restore()` — `deal.updated` is the only subscribed event.
      kind: 'updated',
      oldSnapshot: existing ?? {},
      newSnapshot: { _deleted: true } as any,
    });
  }

  // Related records

  /**
   * Tickets raised against this deal.
   *
   * Reads through the registered Ticket model rather than a raw driver
   * collection, so the tenant plugin applies the same predicate it applies
   * everywhere else instead of this method rebuilding it by hand.
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

    const filter = {
      dealId,
      deletedAt: null,
      ...buildCrmReportVisibilityFilter(this.cls, 'Ticket'),
    };

    const [data, total] = await Promise.all([
      this.ticketModel
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(50)
        .lean()
        .exec(),
      this.ticketModel.countDocuments(filter).exec(),
    ]);

    return { data, total };
  }

  /** Called when an activity is logged so stale-deal detection sees the touch. */
  async touchActivity(id: string, session?: ClientSession): Promise<void> {
    await this.repository.updateIfExists(
      id,
      { lastActivityAt: new Date() } as Partial<Deal>,
      session,
    );
  }

  // Import

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
    const headers = await createParser(format).readHeaders(
      Readable.from(file.buffer),
    );
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
    const targets = Object.values(dto.mapping ?? {});
    if (!targets.includes('title')) {
      throw new BadRequestException('mapping must include title');
    }

    const validFields = new Set<string>(DEAL_IMPORT_MAPPABLE_FIELDS);
    const unmapped = targets.filter((field) => !validFields.has(field));
    if (unmapped.length) {
      throw new BadRequestException(
        `Invalid mapping target(s): ${unmapped.join(', ')}`,
      );
    }

    if (dto.deduplication) {
      const allowed = new Set(['title', 'externalId']);
      const bad = dto.deduplication.matchingFields.filter(
        (field) => !allowed.has(field),
      );
      if (bad.length) {
        throw new BadRequestException(
          `Unsupported dedup matchingFields: ${bad.join(', ')}`,
        );
      }
    }

    if (!(await this.importStorage.importFileExists(dto.fileKey))) {
      throw new BadRequestException(
        'fileKey not found in storage — upload the file again',
      );
    }

    // Resolved here, in request context, because the worker has no CLS tenant to
    // look up the tenant's default pipeline from.
    const placement = await this.dealSettings.resolvePlacement({});

    const tenantId = this.resolveTenantId();
    const userId = this.getCurrentUserId() ?? 'system';
    const fileName = dto.fileName ?? dto.fileKey.split('/').pop() ?? 'unknown';

    const job = await this.importQueue.add('import', {
      tenantId,
      userId,
      fileKey: dto.fileKey,
      mapping: dto.mapping,
      deduplication: dto.deduplication,
      dryRun: dto.dryRun ?? false,
      triggerAutomations: dto.triggerAutomations ?? false,
      estimatedRows: dto.estimatedRows,
      fileName,
      defaultPipelineId: placement.pipelineId,
      defaultStageId: placement.stageId,
    });

    try {
      await this.importJobModel.create({
        tenantId,
        userId,
        entityType: 'deal',
        fileName,
        fileFormat:
          dto.fileFormat ?? (dto.fileKey.endsWith('.xlsx') ? 'xlsx' : 'csv'),
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
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(50, Math.max(1, options.limit ?? 10));

    const filter: Record<string, any> = {
      tenantId: this.resolveTenantId(),
      userId: this.getCurrentUserId() ?? 'system',
      entityType: 'deal',
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
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('userId', 'firstName lastName email avatar')
        .lean()
        .exec(),
      this.importJobModel.countDocuments(filter).exec(),
    ]);

    for (const record of data) {
      await this.hydrateLiveJobState(record as Record<string, any>);
      this.flattenJobUser(record as Record<string, any>);
    }
    return { data, total, page, limit };
  }

  async getImportJobDetail(id: string) {
    const doc = await this.importJobModel
      .findOne({
        _id: id,
        tenantId: this.resolveTenantId(),
        userId: this.getCurrentUserId() ?? 'system',
        entityType: 'deal',
      })
      .lean()
      .exec();
    if (!doc) throw new NotFoundException('Import job not found');
    await this.hydrateLiveJobState(doc as Record<string, any>);
    return doc;
  }

  async getImportStatus(jobId: string) {
    const job = await this.importQueue.getJob(jobId);
    const tenantId = this.resolveTenantId();
    const userId = this.getCurrentUserId();

    if (
      !job ||
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

  getImportReport(token: string) {
    return this.importStorage.readLocalReport(token);
  }

  /** Queue state outranks the stored snapshot while a job is still running. */
  private async hydrateLiveJobState(record: Record<string, any>) {
    if (record.status !== 'active' && record.status !== 'queued') return;
    try {
      const job = await this.importQueue.getJob(record.bullJobId);
      if (!job) return;
      record.status = await job.getState();
      if (job.progress && typeof job.progress === 'object') {
        record.progress = job.progress;
      }
    } catch {
      // A queue read failure leaves the stored status in place.
    }
  }

  private flattenJobUser(record: Record<string, any>) {
    const user = record.userId;
    if (!user || typeof user !== 'object' || !user.firstName) return;
    record.user = {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      avatar: user.avatar,
    };
    record.userId = String(user._id);
  }

  // Export

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

  // Automation

  /**
   * Notify the Automation Engine after a successful write. Deal triggers were
   * selectable in the workflow builder while nothing emitted the event, so
   * `record_created.Deal` workflows could be published and never fire.
   */
  private buildAutomationEvent(
    event: 'record_created' | 'field_updated',
    record: Deal,
    changedFields?: string[],
  ): AutomationEventPayload {
    const tenantId = this.resolveTenantId();
    if (!tenantId) {
      throw new Error('Tenant context is required for Deal automation.');
    }

    return {
      tenantId,
      event,
      object: 'Deal',
      recordId: record.id,
      data: record as any,
      ...(changedFields ? { changedFields } : {}),
      automationDepth: 0,
      // Feeds `runAs: 'trigger_user'`. Read at emit time because the worker that
      // evaluates this event has no request to read it from.
      triggerUserId: this.getCurrentUserId() ?? null,
    };
  }
}
