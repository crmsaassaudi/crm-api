import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { BusinessException } from '../common/exceptions/business.exception';
import { TICKET_ERRORS } from './constants/ticket-error-codes';
import { InjectQueue } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { Readable } from 'stream';
import { TicketRepository } from './infrastructure/persistence/document/repositories/ticket.repository';
import { Ticket } from './domain/ticket';
import { TicketSettingsService } from '../ticket-settings/ticket-settings.service';
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
  TICKET_IMPORT_QUEUE,
  TICKET_EXPORT_QUEUE,
  TICKET_IMPORT_MAX_FILE_BYTES,
  TICKET_IMPORT_MAPPABLE_FIELDS,
  TICKET_MAX_BULK_TAG_SIZE,
  TICKET_MAX_CATEGORY_DEPTH,
} from './tickets.constants';
import { StartTicketImportDto } from './dto/start-ticket-import.dto';
import { ExportRequestService, ExportRequestDto } from '../common/export';
import { CrmSettingsService } from '../crm-settings/crm-settings.service';
import { TagsService } from '../tags/tags.service';
import {
  buildReferenceFilter,
  buildReparentUpdate,
} from '../common/references/entity-reference';
import { TICKET_MERGE_REFERENCES } from './ticket-references.registry';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { loadCustomFieldDefinitions } from '../utils/custom-field-filter';
import { CustomFieldValueValidator } from '../custom-fields/custom-field-value.validator';
import { logSwallowed } from '../common/utils/log-swallowed';
import { RecordWriteValidator } from '../object-manager/validation/record-write-validator.service';
import { AuthorizationService } from '../common/permissions/authorization.service';
import { TicketNumberService } from './ticket-number.service';
import {
  TicketEvents,
  TicketStatusChangedEvent,
  TicketStatusTransition,
} from './domain/ticket-events';

@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);
  private readonly importStorage: ImportStorageService;

  constructor(
    private readonly repository: TicketRepository,
    private readonly ticketSettingsService: TicketSettingsService,
    private readonly automationOutbox: AutomationOutboxService,
    private readonly cls: ClsService,
    private readonly entityAudit: EntityAuditService,
    private readonly storageFactory: ImportStorageFactory,
    @InjectQueue(TICKET_IMPORT_QUEUE)
    private readonly importQueue: Queue,
    @InjectQueue(TICKET_EXPORT_QUEUE)
    private readonly exportQueue: Queue,
    @InjectModel(ImportJobSchemaClass.name)
    private readonly importJobModel: Model<ImportJobDocument>,
    private readonly exportRequest: ExportRequestService,
    private readonly tagsService: TagsService,
    private readonly crmSettings: CrmSettingsService,
    // Raw connection for the merge re-parent pass: injecting ActivityLogModule and
    // TasksModule here would close a dependency cycle with ContactsModule.
    @InjectConnection() private readonly connection: Connection,
    private readonly writeValidator: RecordWriteValidator,
    private readonly ticketNumbers: TicketNumberService,
    private readonly events: EventEmitter2,
    @Optional() private readonly customFields?: CustomFieldsService,
    @Optional()
    private readonly customFieldValidator?: CustomFieldValueValidator,
    @Optional() private readonly authorization?: AuthorizationService,
  ) {
    this.importStorage = this.storageFactory.create('tickets');
  }

  async bulkTagTickets(params: {
    ticketIds: string[];
    tags: string[];
  }): Promise<{ success: true; matchedCount: number; modifiedCount: number }> {
    if (!Array.isArray(params.ticketIds) || !Array.isArray(params.tags)) {
      throw new BadRequestException('ticketIds and tags must be arrays');
    }
    for (const id of params.ticketIds) this.assertObjectId(id, 'ticketIds');
    for (const id of params.tags) this.assertObjectId(id, 'tags');
    const ticketIds = Array.from(new Set(params.ticketIds || [])).filter(
      Boolean,
    );
    const tags = Array.from(
      new Set((params.tags || []).map((tag) => tag.trim()).filter(Boolean)),
    );

    if (ticketIds.length === 0) {
      throw new BadRequestException('ticketIds is required');
    }
    if (ticketIds.length > TICKET_MAX_BULK_TAG_SIZE) {
      throw new BadRequestException(
        `Bulk operation exceeds maximum of ${TICKET_MAX_BULK_TAG_SIZE} tickets per request. Received: ${ticketIds.length}`,
      );
    }
    if (tags.length === 0) {
      throw new BadRequestException('tags is required');
    }

    await this.tagsService.validateTagIds('Ticket', tags);

    const tickets = await this.repository.findManyByIds(ticketIds);
    if (tickets.length !== ticketIds.length) {
      throw new NotFoundException('One or more tickets were not found');
    }
    // Bound authorization concurrency so a 500-record operation cannot create
    // 500 simultaneous ACL/ABAC database lookups.
    for (let offset = 0; offset < tickets.length; offset += 20) {
      await Promise.all(
        tickets
          .slice(offset, offset + 20)
          .map((ticket) =>
            this.assertRecordAccess(
              'edit',
              'tickets',
              ticket.id,
              ticket as any,
            ),
          ),
      );
    }

    const result = await this.repository.addTagsToTickets(ticketIds, tags);

    for (const ticket of tickets) {
      this.emitMutationAudit(ticket.id, ticket, {
        ...ticket,
        tags: Array.from(new Set([...(ticket.tags ?? []), ...tags])),
      });
    }

    return {
      success: true,
      ...result,
    };
  }

  // Helpers

  /**
   * ObjectId ref fields that should be converted from '' to undefined.
   * Prevents Mongoose CastError when empty strings hit ObjectId casts.
   */
  private static readonly OBJECT_ID_FIELDS = [
    'contactId',
    'accountId',
    'ownerId',
    'groupId',
    'statusId',
    'typeId',
    'sourceId',
    'dealId',
    'parentTicketId',
    'omniConversationId',
    'resolutionCodeId',
    'slaPolicyId',
  ] as const;

  /** Convert empty string ObjectId refs to undefined in-place. */
  private cleanRefs<T extends Record<string, any>>(data: T): T {
    for (const key of TicketsService.OBJECT_ID_FIELDS) {
      if ((data as any)[key] === '') {
        (data as any)[key] = undefined;
      }
    }
    return data;
  }

  private assertObjectId(
    value: unknown,
    field: string,
  ): asserts value is string {
    if (typeof value !== 'string' || !Types.ObjectId.isValid(value)) {
      throw new BadRequestException(`${field} is not a valid id`);
    }
  }

  private async validateTenantReferences(
    data: Record<string, any>,
  ): Promise<void> {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    if (!tenantId)
      throw new Error('Tenant context is required for ticket references');
    const tenantValue = Types.ObjectId.isValid(String(tenantId))
      ? new Types.ObjectId(String(tenantId))
      : tenantId;
    // Collections whose delete is a soft delete: a reference to a record in the
    // recycle bin is a dangling reference, so it is refused like a missing one.
    const softDeleted = new Set([
      'contacts',
      'accounts',
      'deals',
      'tasks',
      'tickets',
    ]);
    const references: Array<[string, string]> = [
      ['contactId', 'contacts'],
      ['accountId', 'accounts'],
      ['dealId', 'deals'],
      ['groupId', 'groups'],
      ['statusId', 'ticket_statuses'],
      ['typeId', 'ticket_types'],
      ['sourceId', 'ticket_sources'],
      ['resolutionCodeId', 'ticket_resolution_codes'],
      ['parentTicketId', 'tickets'],
      ['ownerId', 'users'],
    ];
    await Promise.all(
      references.map(async ([field, collection]) => {
        const value = data[field];
        if (value === undefined || value === null) return;
        if (!Types.ObjectId.isValid(String(value))) {
          throw new BadRequestException(`${field} is not a valid id`);
        }
        // These are raw driver reads, so the tenant plugin does not apply and
        // the predicate is spelled out here rather than built out of sight.
        const exists = await this.connection.collection(collection).findOne({
          _id: new Types.ObjectId(String(value)),
          ...(collection === 'users'
            ? { 'tenants.tenantId': tenantValue }
            : { tenantId: tenantValue }),
          ...(softDeleted.has(collection) ? { deletedAt: null } : {}),
        });
        if (!exists) {
          throw new BadRequestException(
            `${field} does not reference an active record in this tenant`,
          );
        }
        if (['contacts', 'accounts', 'deals', 'tickets'].includes(collection)) {
          await this.assertRecordAccess(
            'view',
            collection,
            String(value),
            exists,
          );
        }
      }),
    );
    if (Array.isArray(data.tags) && data.tags.length > 0) {
      await this.tagsService.validateTagIds('Ticket', data.tags);
    }
    if (data.relatedTo) {
      const targets: Record<string, { collection: string; nameField: string }> =
        {
          Deal: { collection: 'deals', nameField: 'name' },
          Ticket: { collection: 'tickets', nameField: 'subject' },
          Contact: { collection: 'contacts', nameField: 'firstName' },
          Account: { collection: 'accounts', nameField: 'name' },
          Task: { collection: 'tasks', nameField: 'title' },
        };
      const target = targets[data.relatedTo.type];
      if (!target || !Types.ObjectId.isValid(String(data.relatedTo._id))) {
        throw new BadRequestException('relatedTo is invalid');
      }
      // Read the whole document, not just the label: it is also the record the
      // ABAC evaluator sees, and a projected record has no `ownerId` for
      // `resource.*` conditions to hold — every scoped user would be refused.
      const related = await this.connection
        .collection(target.collection)
        .findOne({
          _id: new Types.ObjectId(String(data.relatedTo._id)),
          tenantId: tenantValue,
          ...(softDeleted.has(target.collection) ? { deletedAt: null } : {}),
        });
      if (!related) {
        throw new BadRequestException(
          'relatedTo does not reference an active record in this tenant',
        );
      }
      await this.assertRecordAccess(
        'view',
        target.collection,
        String(related._id),
        related,
      );
      const label =
        data.relatedTo.type === 'Contact'
          ? [related.firstName, related.lastName].filter(Boolean).join(' ')
          : related[target.nameField];
      data.relatedTo = {
        type: data.relatedTo.type,
        _id: String(related._id),
        id: String(related._id),
        name: String(label ?? ''),
      };
    }
  }

  /**
   * Resource-level RBAC check for a capability the route decorator cannot
   * express, because whether it applies depends on the payload.
   *
   * `PATCH /tickets/:id` is one route that carries several capabilities: the
   * same call edits a subject, resolves a case or reopens one. Declaring
   * `tickets:resolve` on the whole route would lock ordinary edits behind it;
   * declaring nothing left case closure gated on `tickets:edit`, which is what
   * it was.
   */
  private async assertPermission(
    action: 'resolve' | 'assign',
    message: string,
  ): Promise<void> {
    const userId = this.getCurrentUserId();
    if (!userId || !this.authorization) {
      throw new Error('Authorization context is required for tickets');
    }
    const decision = await this.authorization.canPerformAction({
      rule: { action, resource: 'tickets' },
      rawUserId: String(userId),
      tenantHint: this.requireTenantId(),
      claims: this.cls.get('claims'),
      env: { ip: this.cls.get('requestIp') },
    });
    if (!decision.allowed) throw new ForbiddenException(message);
  }

  private async assertRecordAccess(
    action: string,
    resource: string,
    resourceId: string,
    record: Record<string, unknown>,
  ): Promise<void> {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    const userId = this.getCurrentUserId();
    if (!tenantId || !userId || !this.authorization) {
      throw new Error('Authorization context is required for ticket relation');
    }
    const allowed = await this.authorization.canAccessRecord({
      tenantId: String(tenantId),
      userId: String(userId),
      action,
      resource,
      resourceId,
      groupIds: this.cls.get('visibleGroupIds') ?? [],
      principalType: this.cls.get('principalType') ?? 'user',
      record,
      env: { ip: this.cls.get('requestIp') },
    });
    if (!allowed) throw new NotFoundException(`${resource} record not found`);
  }

  async exportTickets(
    dto: ExportRequestDto,
  ): Promise<{ jobId: string; status: 'queued' }> {
    const querySnapshot = {
      filters: dto.filters ?? [],
      search: dto.search,
    };
    return this.exportRequest.enqueue({
      entityType: 'ticket',
      queue: this.exportQueue,
      format: dto.format,
      ids: dto.ids,
      columns: dto.columns,
      legacyFilters: {
        ...querySnapshot,
        __customFieldDefinitions: await loadCustomFieldDefinitions(
          this.customFields,
          'Ticket',
          dto.filters,
        ),
      },
      filterSnapshot: { ids: dto.ids, ...querySnapshot },
    });
  }

  getExportStatus(jobId: string) {
    return this.exportRequest.status(this.exportQueue, jobId);
  }

  cancelExport(jobId: string) {
    return this.exportRequest.cancel('ticket', jobId);
  }

  listExportJobs(options: { page?: number; limit?: number; status?: string }) {
    return this.exportRequest.list('ticket', this.exportQueue, options);
  }

  getExportDownload(token: string) {
    return this.exportRequest.download('tickets', token);
  }

  async create(data: Partial<Ticket>): Promise<Ticket> {
    this.cleanRefs(data as Record<string, any>);
    await this.writeValidator.assertValid(
      'Ticket',
      data as unknown as Record<string, unknown>,
      'create',
    );
    await this.validateTenantReferences(data as Record<string, any>);
    await this.assertCategoryPath(data.categoryPath);
    const customFields = this.customFieldValidator
      ? await this.customFieldValidator.validate('Ticket', data.customFields, {
          strict: true,
        })
      : data.customFields;

    const tenantId = this.requireTenantId();
    const statusId = data.statusId ?? (await this.defaultStatusId());
    const ticketNumber = await this.ticketNumbers.next(tenantId);

    const ticket = await this.automationOutbox.runWithEvent(
      (session) =>
        this.repository.create(
          {
            ...data,
            statusId,
            ticketNumber,
            isSlaBreached: false,
            reopenCount: 0,
            // The flag the assignment engine reads. Without it every ticket
            // looked deliberately owned by whoever created it, and routing
            // never ran. `data.ownerId` is set only when a human picked one:
            // the repository's creator default is applied after this point.
            ownerAssignedExplicitly: Boolean(data.ownerId),
            customFields,
          } as any,
          session,
        ),
      (created) => this.buildAutomationEvent('record_created', created),
    );

    this.entityAudit.emit({
      entity: 'ticket',
      entityType: 'TICKET',
      entityId: ticket.id,
      kind: 'created',
      newSnapshot: ticket,
    });

    return ticket;
  }

  /** The tenant's default status, used when the caller does not pick one. */
  private async defaultStatusId(): Promise<string> {
    const statuses = await this.ticketSettingsService.findAllStatuses();
    const fallback = statuses.find((status) => status.isDefault) ?? statuses[0];
    if (!fallback) {
      throw new BadRequestException(
        'This tenant has no ticket statuses configured',
      );
    }
    return String(fallback._id);
  }

  private requireTenantId(): string {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    if (!tenantId) throw new Error('Tenant context is required for tickets');
    return String(tenantId);
  }

  /**
   * Check `categoryPath` against the tenant's configured category tree.
   *
   * The field is an array of node ids and nothing validated it, so any string
   * was storable — including ids from a tree the tenant later edited. A ticket
   * filed under a node that does not exist is unfindable by the category
   * filter and unlabelled on screen.
   */
  private async assertCategoryPath(path?: string[]): Promise<void> {
    if (!path?.length) return;
    if (path.length > TICKET_MAX_CATEGORY_DEPTH) {
      throw new BadRequestException(
        `categoryPath must not exceed ${TICKET_MAX_CATEGORY_DEPTH} levels`,
      );
    }

    const setting = await this.crmSettings.getSetting('ticket_category');
    const roots = (setting as any)?.categories;
    if (!Array.isArray(roots)) {
      throw new BadRequestException(
        'This tenant has no ticket category tree configured',
      );
    }

    let level: Array<{ id: string; children?: any[] }> = roots;
    for (const nodeId of path) {
      const node = level.find((entry) => String(entry.id) === String(nodeId));
      if (!node) {
        throw new BadRequestException(
          `categoryPath contains "${nodeId}", which is not a node at that level of the category tree`,
        );
      }
      level = Array.isArray(node.children) ? node.children : [];
    }
  }

  async findAll(filter: any): Promise<any> {
    const page = Math.max(1, Number(filter.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(filter.limit) || 20));
    for (const field of ['statusIds', 'priorities'] as const) {
      if (filter[field] !== undefined && typeof filter[field] !== 'string') {
        throw new BadRequestException(
          `${field} must be a comma-separated string`,
        );
      }
    }
    const statusIds = String(filter.statusIds ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (
      statusIds.length > 100 ||
      statusIds.some((value) => !Types.ObjectId.isValid(value))
    ) {
      throw new BadRequestException('statusIds contains an invalid id');
    }
    const priorities = String(filter.priorities ?? '')
      .split(',')
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean);
    if (
      priorities.length > 20 ||
      priorities.some(
        (value) => !['URGENT', 'HIGH', 'MEDIUM', 'LOW'].includes(value),
      )
    ) {
      throw new BadRequestException('priorities contains an invalid value');
    }
    if (typeof filter.filters === 'string') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(filter.filters);
      } catch {
        throw new BadRequestException('filters must be valid JSON');
      }
      if (!Array.isArray(parsed) || parsed.length > 100) {
        throw new BadRequestException(
          'filters must be an array of at most 100 items',
        );
      }
    }
    const filterOptions = {
      ...filter,
      __customFieldDefinitions: await loadCustomFieldDefinitions(
        this.customFields,
        'Ticket',
        filter.filters,
      ),
    };
    return this.repository.findManyWithPagination({
      filterOptions,
      paginationOptions: {
        page,
        limit,
      },
    });
  }

  async findOne(id: string): Promise<Ticket | null> {
    return this.repository.findOne({ _id: id });
  }

  async update(
    id: string,
    data: Partial<Ticket> & { allowReopen?: boolean; version?: number },
  ): Promise<Ticket> {
    // Snapshot before update for audit trail
    const existingTicket = await this.repository.findOne({ _id: id });
    // `findOne` is scoped by tenant, data-visibility and the ABAC deny, so a
    // miss means "not yours to edit". Refusing here rather than letting the
    // write miss keeps the answer a 404 and skips the validation work a denied
    // request should never pay for.
    if (!existingTicket) {
      throw new NotFoundException(`Ticket ${id} not found`);
    }

    const { allowReopen, version, ...payload } = data;
    this.cleanRefs(payload as Record<string, any>);
    await this.writeValidator.assertValid(
      'Ticket',
      payload as unknown as Record<string, unknown>,
      'update',
    );
    await this.validateTenantReferences(payload as Record<string, any>);
    await this.assertCategoryPath(payload.categoryPath);

    const customFields = this.customFieldValidator
      ? await this.customFieldValidator.validate(
          'Ticket',
          payload.customFields,
          { partial: true, strict: true },
        )
      : payload.customFields;
    const updateData: any = {
      ...payload,
      ...(customFields !== undefined ? { customFields } : {}),
    };

    // Transferring a ticket is its own capability: ownership is the primary
    // visibility axis, so moving one is moving it between people's scopes.
    // A human choosing an owner also makes the assignment deliberate, which is
    // what stops the routing engine claiming it back.
    if (
      payload.ownerId &&
      String(payload.ownerId) !== String((existingTicket as any).ownerId ?? '')
    ) {
      await this.assertPermission(
        'assign',
        'Reassigning a ticket requires tickets:assign',
      );
      updateData.ownerAssignedExplicitly = true;
    }

    const transition = await this.applyStatusTransition(
      existingTicket,
      { ...payload, allowReopen },
      updateData,
    );

    const changedFields = Object.keys(updateData);
    const updated = await this.automationOutbox.runWithEvent(
      (session) =>
        this.repository.updateWithVersion(id, updateData, version, session),
      (result) =>
        result
          ? this.buildAutomationEvent('field_updated', result, changedFields)
          : null,
    );

    this.entityAudit.emit({
      entity: 'ticket',
      entityType: 'TICKET',
      entityId: id,
      kind: 'updated',
      oldSnapshot: existingTicket,
      newSnapshot: updated,
    });

    if (transition) {
      this.events.emit(TicketEvents.STATUS_CHANGED, {
        tenantId: this.requireTenantId(),
        ticketId: id,
        actorId: this.getCurrentUserId() ?? null,
        ...transition,
      } satisfies TicketStatusChangedEvent);
    }

    return updated;
  }

  /**
   * Validate a status transition and derive the lifecycle stamps it implies.
   *
   * Returns what actually changed so the caller can emit the SLA signal and
   * write the timeline entry from one decision rather than re-deriving it.
   * Called only when `statusId` is present in the update payload.
   */
  private async applyStatusTransition(
    existingTicket: Ticket,
    data: Partial<Ticket> & { allowReopen?: boolean },
    updateData: Record<string, any>,
  ): Promise<TicketStatusTransition | null> {
    if (!data.statusId) return null;

    const previousStatusId = (existingTicket as any).statusId;
    if (
      previousStatusId &&
      String(previousStatusId) === String(data.statusId)
    ) {
      return null;
    }

    const [previousStatus, nextStatus] = await Promise.all([
      previousStatusId
        ? this.ticketSettingsService.findStatusById(String(previousStatusId))
        : null,
      this.ticketSettingsService.findStatusById(data.statusId),
    ]);

    if (!nextStatus) {
      throw new BadRequestException('statusId is not a status in this tenant');
    }

    const isReopen =
      Boolean(previousStatus?.isTerminal) && !nextStatus.isTerminal;

    // Ending a customer's case, and reversing that decision, are their own
    // capability. Gating both on `tickets:edit` meant any agent who could fix a
    // typo could also close the case — and `tickets:resolve` sat unused in the
    // registry and in two role templates while it did.
    if (nextStatus.isTerminal || isReopen) {
      await this.assertPermission(
        'resolve',
        isReopen
          ? 'Reopening a ticket requires tickets:resolve'
          : 'Closing or resolving a ticket requires tickets:resolve',
      );
    }

    if (isReopen && data.allowReopen !== true) {
      throw new BusinessException(
        TICKET_ERRORS.REOPEN_NOT_CONFIRMED,
        HttpStatus.CONFLICT,
        `Ticket is in terminal status "${previousStatus!.label}". Reopening requires allowReopen=true.`,
      );
    }

    const now = new Date();

    if (isReopen) {
      // Clear the terminal stamps rather than leaving them behind: a live
      // ticket that still carries `resolvedAt` is counted as resolved by every
      // resolution metric and drops out of the owner's open-work count. The
      // resolution code goes with them — it describes an outcome that no
      // longer holds.
      updateData.resolvedAt = null;
      updateData.closedAt = null;
      updateData.resolutionCodeId = null;
      updateData.reopenedAt = now;
      updateData.reopenCount = ((existingTicket as any).reopenCount ?? 0) + 1;
    }

    // Resolved and Closed are distinct outcomes. Entering "Resolved" does not
    // close the ticket, and closing a ticket that was never resolved (spam, a
    // duplicate, a customer who went quiet) must not fabricate a resolution.
    if (nextStatus.terminalKind === 'resolved' && !data.resolvedAt) {
      updateData.resolvedAt = now;
    }
    if (nextStatus.terminalKind === 'closed' && !data.closedAt) {
      updateData.closedAt = now;
    }

    return {
      previousStatus: previousStatus
        ? {
            id: String((previousStatus as any)._id),
            label: previousStatus.label,
            isTerminal: previousStatus.isTerminal,
            pausesSla: (previousStatus as any).pausesSla ?? false,
          }
        : null,
      nextStatus: {
        id: String((nextStatus as any)._id),
        label: nextStatus.label,
        isTerminal: nextStatus.isTerminal,
        terminalKind: (nextStatus as any).terminalKind ?? null,
        pausesSla: (nextStatus as any).pausesSla ?? false,
      },
      isReopen,
    };
  }

  // RECYCLE BIN
  //
  // `remove()` is a soft delete (the schema declares `deletedAt`), so without these
  // two methods a deleted ticket was invisible everywhere and recoverable nowhere —
  // strictly worse than the hard delete it replaced, because the row also stayed in
  // the database forever.

  async listDeleted(options: { page?: number; limit?: number }): Promise<{
    data: Ticket[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(100, Math.max(1, options.limit ?? 25));
    const { data, total } = await this.repository.findDeleted({ page, limit });
    return { data, total, page, limit };
  }

  async restore(id: string): Promise<Ticket> {
    const restored = await this.repository.restore(id);
    if (!restored) {
      throw new NotFoundException(
        'Ticket not found in the recycle bin — it may already have been purged',
      );
    }

    this.entityAudit.emit({
      entity: 'ticket',
      entityType: 'TICKET',
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
      entity: 'ticket',
      entityType: 'TICKET',
      entityId: id,
      kind: 'updated',
      oldSnapshot: existing ?? {},
      newSnapshot: { _deleted: true } as any,
    });
  }

  // Automation Event Emitter

  private buildAutomationEvent(
    event: 'record_created' | 'field_updated',
    record: Ticket,
    changedFields?: string[],
  ): AutomationEventPayload | null {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    if (!tenantId) {
      throw new Error('Tenant context is required for Ticket automation.');
    }

    const payload: AutomationEventPayload = {
      tenantId,
      event,
      object: 'Ticket',
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

  private getCurrentUserId(): string | undefined {
    return this.cls.get('userId') ?? this.cls.get('user.id');
  }

  // TICKET IMPORT

  async uploadImportFile(file: {
    buffer: Buffer;
    originalname: string;
    size: number;
  }): Promise<{ fileKey: string; format: string; headers: string[] }> {
    if (!file) throw new BadRequestException('No file uploaded');
    if (file.size > TICKET_IMPORT_MAX_FILE_BYTES) {
      throw new BadRequestException(
        `File exceeds the ${TICKET_IMPORT_MAX_FILE_BYTES / (1024 * 1024)}MB limit`,
      );
    }
    const format = detectFormat(file.originalname);
    if (
      format === 'xlsx' &&
      !(
        file.buffer.length >= 4 &&
        file.buffer[0] === 0x50 &&
        file.buffer[1] === 0x4b &&
        file.buffer[2] === 0x03 &&
        file.buffer[3] === 0x04
      )
    ) {
      throw new BadRequestException('Invalid XLSX file signature');
    }
    if (format === 'csv' && file.buffer.subarray(0, 8_192).includes(0)) {
      throw new BadRequestException('CSV file contains binary data');
    }
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
    dto: StartTicketImportDto,
  ): Promise<{ jobId: string; status: 'queued' }> {
    const mappingEntries = Object.entries(dto.mapping ?? {});
    if (mappingEntries.length === 0 || mappingEntries.length > 200) {
      throw new BadRequestException(
        'mapping must contain between 1 and 200 columns',
      );
    }
    if (
      mappingEntries.some(
        ([header, target]) =>
          header.length === 0 ||
          header.length > 500 ||
          typeof target !== 'string' ||
          target.length > 100,
      )
    ) {
      throw new BadRequestException(
        'mapping contains an invalid column or target',
      );
    }
    const mappedFields = new Set(Object.values(dto.mapping ?? {}));
    if (!mappedFields.has('subject')) {
      throw new BadRequestException('mapping must include subject');
    }

    const validFields = new Set<string>(TICKET_IMPORT_MAPPABLE_FIELDS);
    const unmapped = Object.values(dto.mapping).filter(
      (f) => !validFields.has(f),
    );
    if (unmapped.length) {
      throw new BadRequestException(
        `Invalid mapping target(s): ${unmapped.join(', ')}`,
      );
    }

    const exists = await this.importStorage.importFileExists(dto.fileKey);
    if (!exists) {
      throw new BadRequestException(
        'fileKey not found in storage — upload the file again',
      );
    }

    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    const userId = this.getCurrentUserId();
    if (!tenantId || !userId) {
      throw new BadRequestException('Authenticated tenant context is required');
    }
    await this.importStorage.assertImportFileOwnership(
      dto.fileKey,
      String(tenantId),
      String(userId),
    );

    const job = await this.importQueue.add('import', {
      tenantId,
      userId,
      fileKey: dto.fileKey,
      mapping: dto.mapping,
      deduplication: dto.deduplication,
      dryRun: dto.dryRun ?? false,
      triggerAutomations: dto.triggerAutomations ?? false,
      estimatedRows: dto.estimatedRows,
      fileName: dto.fileName ?? dto.fileKey.split('/').pop() ?? 'unknown',
    });

    try {
      await this.importJobModel.create({
        tenantId,
        userId,
        entityType: 'ticket',
        fileName: dto.fileName ?? dto.fileKey.split('/').pop() ?? 'unknown',
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
        `Failed to persist ticket import history: ${(err as Error).message}`,
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
      entityType: 'ticket',
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
      await this.enrichBullJobStatus(doc as any);
      this.extractPopulatedUser(doc as any);
    }
    return { data, total, page, limit };
  }

  /** Sync in-progress job status from BullMQ. */
  private async enrichBullJobStatus(doc: any): Promise<void> {
    if (doc.status !== 'active' && doc.status !== 'queued') return;
    try {
      const bullJob = await this.importQueue.getJob(doc.bullJobId);
      if (!bullJob) return;
      doc.status = await bullJob.getState();
      if (bullJob.progress && typeof bullJob.progress === 'object') {
        doc.progress = bullJob.progress;
      }
    } catch (error) {
      logSwallowed(this.logger, 'ticket import queue status enrichment')(error);
    }
  }

  /** Extract populated user object from userId. */
  private extractPopulatedUser(doc: any): void {
    if (
      !doc.userId ||
      typeof doc.userId !== 'object' ||
      !doc.userId.firstName
    ) {
      return;
    }
    doc.user = {
      firstName: doc.userId.firstName,
      lastName: doc.userId.lastName,
      email: doc.userId.email,
      avatar: doc.userId.avatar,
    };
    doc.userId = String(doc.userId._id);
  }

  async getImportJobDetail(id: string) {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    const userId = this.getCurrentUserId() ?? 'system';
    const doc = await this.importJobModel
      .findOne({ _id: id, tenantId, userId, entityType: 'ticket' })
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
      } catch (error) {
        logSwallowed(this.logger, 'ticket import job detail enrichment')(error);
      }
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

  // DEAL LINK

  /**
   * Link a Deal to this Ticket.
   *
   * One-directional on purpose. The previous comment here claimed it was bi-directional
   * and appended to `deal.ticketIds[]` — it never did, and `ticketIds` existed on the
   * Deal domain class but on neither the schema nor the mapper. The deal's tickets come
   * from querying `tickets.dealId`, so there is one source of truth to keep correct.
   */
  async linkDeal(ticketId: string, dealId: string): Promise<Ticket> {
    this.assertObjectId(dealId, 'dealId');
    const ticket = await this.repository.findOne({ _id: ticketId });
    if (!ticket)
      throw new BusinessException(
        TICKET_ERRORS.NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Ticket not found',
      );

    if ((ticket as any).dealId === dealId) {
      // Already linked — idempotent
      return ticket;
    }

    await this.validateTenantReferences({ dealId });
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    const deal = await this.connection.collection('deals').findOne({
      _id: new Types.ObjectId(dealId),
      tenantId: Types.ObjectId.isValid(String(tenantId))
        ? new Types.ObjectId(String(tenantId))
        : tenantId,
    });
    if (!deal) throw new NotFoundException('deals record not found');
    await this.assertRecordAccess('view', 'deals', dealId, deal);

    const updated = await this.repository.update(ticketId, {
      dealId,
    } as any);

    if (!updated) throw new NotFoundException('Ticket not found after update');

    this.logger.log(
      `[TicketDealLink] Ticket ${ticketId} ↔ Deal ${dealId} linked`,
    );
    this.emitMutationAudit(ticketId, ticket, updated);
    return updated;
  }

  /**
   * Unlink the Deal from this Ticket.
   * Clears ticket.dealId.
   */
  async unlinkDeal(ticketId: string): Promise<Ticket> {
    const ticket = await this.repository.findOne({ _id: ticketId });
    if (!ticket)
      throw new BusinessException(
        TICKET_ERRORS.NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Ticket not found',
      );

    const updated = await this.repository.update(ticketId, {
      dealId: null,
    } as any);

    if (!updated) throw new NotFoundException('Ticket not found after update');

    this.logger.log(`[TicketDealLink] Ticket ${ticketId} deal unlinked`);
    this.emitMutationAudit(ticketId, ticket, updated);
    return updated;
  }

  /**
   * Find all tickets linked to a specific deal.
   */
  async findByDeal(dealId: string): Promise<Ticket[]> {
    const result = await this.repository.findManyWithPagination({
      filterOptions: { dealId },
      paginationOptions: { page: 1, limit: 50 },
    });
    return (result as any).data ?? [];
  }

  // PARENT/CHILD TICKET

  /**
   * Set the parent of a ticket (makes this ticket a sub-ticket).
   * Validates:
   *  - Parent ticket exists
   *  - Not creating a circular reference (parent cannot be a child of self)
   */
  async setParent(ticketId: string, parentTicketId: string): Promise<Ticket> {
    this.assertObjectId(parentTicketId, 'parentTicketId');
    if (ticketId === parentTicketId) {
      throw new BadRequestException('A ticket cannot be its own parent');
    }

    const [ticket, parentTicket] = await Promise.all([
      this.repository.findOne({ _id: ticketId }),
      this.repository.findOne({ _id: parentTicketId }),
    ]);

    if (!ticket)
      throw new BusinessException(
        TICKET_ERRORS.NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Ticket not found',
      );
    if (!parentTicket) throw new NotFoundException('Parent ticket not found');
    await this.assertRecordAccess(
      'view',
      'tickets',
      parentTicketId,
      parentTicket as any,
    );

    // Walk the complete ancestor chain. A one-level check misses A -> B -> C
    // followed by C -> A. Bound the walk to protect against legacy corrupt data.
    const visited = new Set<string>([parentTicketId]);
    let ancestorId: string | null = (parentTicket as any).parentTicketId
      ? String((parentTicket as any).parentTicketId)
      : null;
    for (let depth = 0; ancestorId && depth < 100; depth += 1) {
      if (ancestorId === ticketId) {
        throw new BadRequestException(
          'Circular parent reference: target is already a descendant of this ticket',
        );
      }
      if (visited.has(ancestorId)) {
        throw new BadRequestException(
          'Ticket hierarchy already contains a circular reference',
        );
      }
      visited.add(ancestorId);
      const next = await this.repository.findParentId(ancestorId);
      if (next === undefined) {
        throw new BadRequestException(
          'Ticket hierarchy contains a missing parent',
        );
      }
      ancestorId = next;
    }
    if (ancestorId) {
      throw new BadRequestException('Ticket hierarchy exceeds 100 levels');
    }

    const updated = await this.repository.update(ticketId, {
      parentTicketId,
    } as any);

    if (!updated) throw new NotFoundException('Ticket not found after update');

    this.logger.log(
      `[TicketHierarchy] Ticket ${ticketId} → parent: ${parentTicketId}`,
    );
    this.emitMutationAudit(ticketId, ticket, updated);
    return updated;
  }

  /**
   * Remove the parent reference (make this ticket a top-level ticket again).
   */
  async removeParent(ticketId: string): Promise<Ticket> {
    const ticket = await this.repository.findOne({ _id: ticketId });
    if (!ticket)
      throw new BusinessException(
        TICKET_ERRORS.NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Ticket not found',
      );

    const updated = await this.repository.update(ticketId, {
      parentTicketId: null,
    } as any);

    if (!updated) throw new NotFoundException('Ticket not found after update');

    this.logger.log(`[TicketHierarchy] Ticket ${ticketId} parent removed`);
    this.emitMutationAudit(ticketId, ticket, updated);
    return updated;
  }

  /**
   * Get all child tickets (sub-tickets) of a given parent ticket.
   */
  async getChildren(parentTicketId: string): Promise<Ticket[]> {
    if (!(await this.repository.findOne({ _id: parentTicketId }))) {
      throw new NotFoundException(`Ticket ${parentTicketId} not found`);
    }
    const result = await this.repository.findManyWithPagination({
      filterOptions: { parentTicketId },
      paginationOptions: { page: 1, limit: 100 },
    });
    return (result as any).data ?? [];
  }

  // MERGE DUPLICATES

  /**
   * Merge a duplicate ticket (sourceId) into a target ticket (targetId).
   *
   * Strategy:
   *  - Appends source ticket info as a system note on the target ticket.
   *  - Updates source ticket status to "merged" (closest to closed) and soft-deletes it.
   *  - Returns the updated target ticket.
   */
  async mergeTickets(targetId: string, sourceId: string): Promise<Ticket> {
    this.assertObjectId(sourceId, 'sourceId');
    if (targetId === sourceId) {
      throw new BadRequestException('Cannot merge a ticket with itself');
    }

    const [target, source] = await Promise.all([
      this.repository.findOne({ _id: targetId }),
      this.repository.findOne({ _id: sourceId }),
    ]);

    if (!target)
      throw new NotFoundException(`Target ticket ${targetId} not found`);
    if (!source)
      throw new NotFoundException(`Source ticket ${sourceId} not found`);

    await this.assertRecordAccess('delete', 'tickets', sourceId, source as any);

    // Append merge note on target
    const existingNotes: string = (target as any).description ?? '';
    const mergeNote = `\n\n---\n[MERGED] Ticket #${(source as any).ticketNumber ?? sourceId} was merged into this ticket.`;
    const mergedNotes = existingNotes + mergeNote;

    // Carry the source's linked omni messages onto the target.
    //
    // Without this the merge only wrote a sentence into the description: the
    // conversation messages that had been linked to the source stayed linked to a
    // ticket that is about to be soft-deleted, so the agent who merged the duplicate
    // lost the very thread they merged it for. Union rather than replace — the target
    // has its own links — and de-duplicated, because the same message can legitimately
    // have been linked to both.
    const mergedMessageIds = Array.from(
      new Set([
        ...(((target as any).linkedMessageIds as string[]) ?? []),
        ...(((source as any).linkedMessageIds as string[]) ?? []),
      ]),
    );

    // Update target with merged description
    const session = await this.connection.startSession();
    let updated!: Ticket;
    try {
      await session.withTransaction(async () => {
        updated = await this.repository.update(
          targetId,
          {
            description: mergedNotes,
            linkedMessageIds: mergedMessageIds,
          } as any,
          session,
        );
        await this.reparentTicketReferences(sourceId, targetId, session);
        await this.repository.softDeleteInSession(sourceId, session);
      });
    } finally {
      await session.endSession();
    }

    // Move the source's timeline onto the target, for the same reason: entries
    // attached to a soft-deleted ticket are unreachable, not deleted. The audit trail
    // is deliberately NOT moved — it records what happened to a specific ticket id,
    // and rewriting it would falsify history; this merge is itself audited below.

    // Soft-delete source ticket (mark as merged via deletedAt).
    // `remove()` on the base repository is a soft delete for any schema declaring
    // `deletedAt` — which is what this comment always claimed and, until the base was
    // fixed, was not: it issued `deleteOne` and destroyed the source outright.

    this.logger.log(`[TicketMerge] Ticket ${sourceId} merged into ${targetId}`);

    // Audit
    this.entityAudit.emit({
      entity: 'ticket',
      entityType: 'TICKET',
      entityId: targetId,
      kind: 'updated',
      oldSnapshot: target ?? {},
      newSnapshot: updated,
    });

    return updated;
  }

  /**
   * Move every registered reference from the merged-away ticket onto the
   * survivor — timeline entries, tasks, child tickets and agent time segments.
   *
   * Driven by `TICKET_MERGE_REFERENCES`: a merge that archives the loser
   * without moving what points at it makes that data unreachable, silently.
   *
   * Reached through the raw connection because injecting ActivityLogModule and
   * TasksModule would close a cycle with ContactsModule. Runs inside the merge
   * transaction, so a failure rolls the merge back rather than half-moving it.
   */
  private async reparentTicketReferences(
    sourceId: string,
    targetId: string,
    session: ClientSession,
  ): Promise<void> {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    if (!tenantId) return;

    for (const ref of TICKET_MERGE_REFERENCES) {
      await this.connection
        .collection(ref.collection)
        .updateMany(
          buildReferenceFilter(ref, sourceId, String(tenantId)),
          buildReparentUpdate(ref, targetId) as any,
          { session },
        );
    }
  }

  // \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 SLA PAUSE / RESUME \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  /**
   * Pause the SLA timer for a ticket.
   * Sets slaPausedAt = now, clears slaResumedAt.
   * Idempotent — calling when already paused is a no-op.
   */
  async pauseSla(ticketId: string): Promise<Ticket> {
    const ticket = await this.repository.findOne({ _id: ticketId });
    if (!ticket)
      throw new BusinessException(
        TICKET_ERRORS.NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Ticket not found',
      );

    // Already paused — idempotent
    if ((ticket as any).slaPausedAt && !(ticket as any).slaResumedAt) {
      return ticket;
    }

    const updated = await this.repository.pauseSlaAtomic(ticketId, new Date());
    // A concurrent request may have paused it first. Re-read and return the
    // winning state to preserve idempotency without a lost update.
    const result =
      updated ?? (await this.repository.findOne({ _id: ticketId }));
    if (!result) throw new NotFoundException('Ticket not found after update');

    this.logger.log(`[SLA] Ticket ${ticketId} SLA paused`);
    this.emitMutationAudit(ticketId, ticket, result);
    return result;
  }

  /**
   * Resume the SLA timer for a ticket.
   * Computes elapsed pause duration and adds it to slaPausedSeconds.
   * Extends firstResponseDueAt and resolutionDueAt by the same duration.
   * Idempotent — calling when not paused is a no-op.
   */
  async resumeSla(ticketId: string): Promise<Ticket> {
    const ticket = await this.repository.findOne({ _id: ticketId });
    if (!ticket)
      throw new BusinessException(
        TICKET_ERRORS.NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Ticket not found',
      );

    const pausedAt = (ticket as any).slaPausedAt;
    const alreadyResumed = (ticket as any).slaResumedAt;

    // Not paused — idempotent
    if (!pausedAt || alreadyResumed) {
      return ticket;
    }

    const now = new Date();
    const additionalPausedSeconds = Math.max(
      0,
      Math.floor((now.getTime() - new Date(pausedAt).getTime()) / 1000),
    );
    const updated = await this.repository.resumeSlaAtomic(ticketId, now);
    const result =
      updated ?? (await this.repository.findOne({ _id: ticketId }));
    if (!result) throw new NotFoundException('Ticket not found after update');

    this.logger.log(
      `[SLA] Ticket ${ticketId} SLA resumed. Paused ${additionalPausedSeconds}s. Deadlines extended.`,
    );
    this.emitMutationAudit(ticketId, ticket, result);
    return result;
  }

  private emitMutationAudit(
    entityId: string,
    oldSnapshot: Ticket,
    newSnapshot: Ticket,
  ): void {
    this.entityAudit.emit({
      entity: 'ticket',
      entityType: 'TICKET',
      entityId,
      kind: 'updated',
      oldSnapshot,
      newSnapshot,
    });
  }
}
