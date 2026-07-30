import {
  BadRequestException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { BusinessException } from '../common/exceptions/business.exception';
import { TICKET_ERRORS } from './constants/ticket-error-codes';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Connection, Model } from 'mongoose';
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
  ) {
    this.importStorage = this.storageFactory.create('tickets');
  }

  async bulkTagTickets(params: {
    ticketIds: string[];
    tags: string[];
  }): Promise<{ success: true; matchedCount: number; modifiedCount: number }> {
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

    const result = await this.repository.addTagsToTickets(ticketIds, tags);

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
    }> = layout?.Ticket || [];

    const errors: Record<string, string> = {};

    for (const field of fieldConfigs) {
      if (!field.isRequired) continue;

      // On update, only validate fields that are present in the payload.
      // This allows partial updates without requiring all required fields.
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

  exportTickets(
    dto: ExportRequestDto,
  ): Promise<{ jobId: string; status: 'queued' }> {
    return this.exportRequest.enqueue({
      entityType: 'ticket',
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
    await this.validateRequiredFields(data as Record<string, any>, 'create');

    const ticketNumber = await this.repository.generateTicketNumber();

    const ticket = await this.automationOutbox.runWithEvent(
      (session) =>
        this.repository.create(
          {
            ...data,
            ticketNumber,
            isSlaBreached: false,
            timeSpentSeconds: 0,
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

  async findAll(filter: any): Promise<any> {
    return this.repository.findManyWithPagination({
      filterOptions: filter,
      paginationOptions: {
        page: Number(filter.page) || 1,
        limit: Number(filter.limit) || 10,
      },
    });
  }

  async findOne(id: string): Promise<Ticket | null> {
    return this.repository.findOne({ _id: id });
  }

  async update(id: string, data: Partial<Ticket>): Promise<Ticket | null> {
    // Snapshot before update for audit trail
    const existingTicket = await this.repository.findOne({ _id: id });

    this.cleanRefs(data as Record<string, any>);
    await this.validateRequiredFields(data as Record<string, any>, 'update');

    const updateData: any = { ...data };

    await this.handleStatusChange(existingTicket, data, updateData);

    const changedFields = Object.keys(data).filter((k) => k !== 'updatedBy');
    const updated = await this.automationOutbox.runWithEvent(
      (session) => this.repository.update(id, updateData, session),
      (result) =>
        result
          ? this.buildAutomationEvent('field_updated', result, changedFields)
          : null,
    );

    // Emit automation event: field_updated.Ticket
    if (updated) {
      // Emit audit trail event: field-level change tracking
      this.entityAudit.emit({
        entity: 'ticket',
        entityType: 'TICKET',
        entityId: id,
        kind: 'updated',
        oldSnapshot: existingTicket ?? {},
        newSnapshot: updated,
      });
    }

    return updated;
  }

  /**
   * Orchestrate status transition validation and terminal-state auto-stamps.
   * Called only when a statusId is present in the update payload.
   */
  private async handleStatusChange(
    existingTicket: Ticket | null,
    data: Partial<Ticket>,
    updateData: any,
  ): Promise<void> {
    if (!data.statusId) return;

    const existingStatusId = (existingTicket as any)?.statusId;
    const isRealTransition =
      existingStatusId && String(existingStatusId) !== String(data.statusId);

    if (isRealTransition) {
      await this.applyStatusTransitionGuard(existingStatusId, data, updateData);
    } else {
      // First-time status set — honour terminal auto-stamp only
      await this.applyTerminalStamps(data.statusId, data, updateData);
    }
  }

  /**
   * Guard: prevent leaving a terminal status without an explicit reopen signal.
   * Auto-stamps resolvedAt/closedAt when transitioning into a terminal status.
   */
  private async applyStatusTransitionGuard(
    oldStatusId: any,
    data: Partial<Ticket>,
    updateData: any,
  ): Promise<void> {
    const [oldStatus, newStatus] = await Promise.all([
      this.ticketSettingsService.findStatusById(String(oldStatusId)),
      this.ticketSettingsService.findStatusById(data.statusId!),
    ]);

    if (oldStatus?.isTerminal && !newStatus?.isTerminal) {
      if ((data as any).allowReopen !== true) {
        throw new BadRequestException(
          `Ticket is in terminal status "${oldStatus.label}". Reopening requires allowReopen=true.`,
        );
      }
    }

    if (newStatus?.isTerminal) {
      this.applyTerminalTimestamps(data, updateData);
    }
  }

  /** Apply resolvedAt/closedAt stamps when moving into a terminal status. */
  private async applyTerminalStamps(
    statusId: string,
    data: Partial<Ticket>,
    updateData: any,
  ): Promise<void> {
    const status = await this.ticketSettingsService.findStatusById(statusId);
    if (status?.isTerminal) {
      this.applyTerminalTimestamps(data, updateData);
    }
  }

  /** Set resolvedAt and closedAt in updateData if not already present. */
  private applyTerminalTimestamps(
    data: Partial<Ticket>,
    updateData: any,
  ): void {
    if (!data.resolvedAt) updateData.resolvedAt = new Date();
    if (!data.closedAt) updateData.closedAt = new Date();
  }

  // ──────────────────────── RECYCLE BIN ────────────────────────
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

  // ── Automation Event Emitter ─────────────────────────────────────────────

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

  // ──────────────────────────── TICKET IMPORT ────────────────────────────

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
    } catch {}
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

  // ──────────────────────────── DEAL LINK ────────────────────────────

  /**
   * Link a Deal to this Ticket.
   *
   * One-directional on purpose. The previous comment here claimed it was bi-directional
   * and appended to `deal.ticketIds[]` — it never did, and `ticketIds` existed on the
   * Deal domain class but on neither the schema nor the mapper. The deal's tickets come
   * from querying `tickets.dealId`, so there is one source of truth to keep correct.
   */
  async linkDeal(ticketId: string, dealId: string): Promise<Ticket> {
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

    const updated = await this.repository.update(ticketId, {
      dealId,
    } as any);

    if (!updated) throw new NotFoundException('Ticket not found after update');

    this.logger.log(
      `[TicketDealLink] Ticket ${ticketId} ↔ Deal ${dealId} linked`,
    );
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

  // ──────────────────────────── PARENT/CHILD TICKET ────────────────────────

  /**
   * Set the parent of a ticket (makes this ticket a sub-ticket).
   * Validates:
   *  - Parent ticket exists
   *  - Not creating a circular reference (parent cannot be a child of self)
   */
  async setParent(ticketId: string, parentTicketId: string): Promise<Ticket> {
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

    // Check that parentTicket is not already a child of ticketId (circular check)
    if ((parentTicket as any).parentTicketId === ticketId) {
      throw new BadRequestException(
        'Circular parent reference: the target parent is already a child of this ticket',
      );
    }

    const updated = await this.repository.update(ticketId, {
      parentTicketId,
    } as any);

    if (!updated) throw new NotFoundException('Ticket not found after update');

    this.logger.log(
      `[TicketHierarchy] Ticket ${ticketId} → parent: ${parentTicketId}`,
    );
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

  // ──────────────────────────── MERGE DUPLICATES ────────────────────────────

  /**
   * Merge a duplicate ticket (sourceId) into a target ticket (targetId).
   *
   * Strategy:
   *  - Appends source ticket info as a system note on the target ticket.
   *  - Updates source ticket status to "merged" (closest to closed) and soft-deletes it.
   *  - Returns the updated target ticket.
   */
  async mergeTickets(targetId: string, sourceId: string): Promise<Ticket> {
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
    const updated = await this.repository.update(targetId, {
      description: mergedNotes,
      linkedMessageIds: mergedMessageIds,
    } as any);

    if (!updated)
      throw new NotFoundException('Target ticket not found after update');

    // Move the source's timeline onto the target, for the same reason: entries
    // attached to a soft-deleted ticket are unreachable, not deleted. The audit trail
    // is deliberately NOT moved — it records what happened to a specific ticket id,
    // and rewriting it would falsify history; this merge is itself audited below.
    await this.reparentTicketReferences(sourceId, targetId);

    // Soft-delete source ticket (mark as merged via deletedAt).
    // `remove()` on the base repository is a soft delete for any schema declaring
    // `deletedAt` — which is what this comment always claimed and, until the base was
    // fixed, was not: it issued `deleteOne` and destroyed the source outright.
    await this.repository.remove(sourceId);

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
   * Move the source ticket's timeline entries and related tasks onto the target.
   *
   * Same shape as the contact merge's re-parent pass, and the same reason: a merge
   * that archives the loser without moving what points at it does not delete data,
   * it makes it unreachable — and nothing errors, so nobody notices.
   *
   * Reached through the raw connection rather than by injecting ActivityLogModule and
   * TasksModule: TicketsModule is already imported by ContactsModule, and adding
   * those two would close a dependency cycle.
   *
   * Best-effort per collection. The merge has already committed by this point, so
   * throwing would leave the caller believing it failed when the target was in fact
   * updated; a logged failure is repairable, a false error is not.
   */
  /**
   * Move every registered reference from the merged-away ticket onto the survivor.
   *
   * Registry-driven since the ticket registry existed. The hand-rolled version this
   * replaces moved `activity_logs` and `tasks` and stopped there, so it missed two
   * references the registry declares:
   *
   *   - **child tickets.** Merging a parent left its children pointing at a
   *     soft-deleted ticket — unreachable, not deleted, which is the original merge
   *     defect reappearing in a domain that had been fixed once already.
   *   - **agent time segments.** The minutes an agent worked stayed attributed to the
   *     archived ticket, so occupancy reporting undercounted the survivor.
   *
   * Per-reference try/catch: one collection failing must not abandon the merge with no
   * record of it, and the audit trail is excluded by policy rather than by omission —
   * `onMerge: 'keep'` on that entry, because it records what happened to a specific id.
   */
  private async reparentTicketReferences(
    sourceId: string,
    targetId: string,
  ): Promise<void> {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    if (!tenantId) return;

    for (const ref of TICKET_MERGE_REFERENCES) {
      try {
        await this.connection
          .collection(ref.collection)
          .updateMany(
            buildReferenceFilter(ref, sourceId, String(tenantId)),
            buildReparentUpdate(ref, targetId) as any,
          );
      } catch (err) {
        this.logger.error(
          `[TicketMerge] Could not move ${ref.label} (${ref.collection}.${ref.field}) ` +
            `for ${sourceId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
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

    const updated = await this.repository.update(ticketId, {
      slaPausedAt: new Date(),
      slaResumedAt: undefined,
    } as any);

    if (!updated) throw new NotFoundException('Ticket not found after update');

    this.logger.log(`[SLA] Ticket ${ticketId} SLA paused`);
    return updated;
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
    const pausedMs = now.getTime() - new Date(pausedAt).getTime();
    const additionalPausedSeconds = Math.floor(pausedMs / 1000);
    const cumulative =
      ((ticket as any).slaPausedSeconds ?? 0) + additionalPausedSeconds;

    // Extend SLA deadlines by the paused duration
    const firstResponseDueAt = (ticket as any).firstResponseDueAt
      ? new Date(
          new Date((ticket as any).firstResponseDueAt).getTime() + pausedMs,
        )
      : undefined;
    const resolutionDueAt = (ticket as any).resolutionDueAt
      ? new Date(new Date((ticket as any).resolutionDueAt).getTime() + pausedMs)
      : undefined;

    const updated = await this.repository.update(ticketId, {
      slaResumedAt: now,
      slaPausedSeconds: cumulative,
      ...(firstResponseDueAt ? { firstResponseDueAt } : {}),
      ...(resolutionDueAt ? { resolutionDueAt } : {}),
    } as any);

    if (!updated) throw new NotFoundException('Ticket not found after update');

    this.logger.log(
      `[SLA] Ticket ${ticketId} SLA resumed. Paused ${additionalPausedSeconds}s. Total paused: ${cumulative}s. Deadlines extended.`,
    );
    return updated;
  }
}
