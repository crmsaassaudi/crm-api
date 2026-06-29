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
import { TicketRepository } from './infrastructure/persistence/document/repositories/ticket.repository';
import { Ticket } from './domain/ticket';
import { TicketSettingsService } from '../ticket-settings/ticket-settings.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  AutomationEventPayload,
  buildAutomationEventName,
} from '../automation-rules/events/automation-event.payload';
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
} from './tickets.constants';
import { StartTicketImportDto } from './dto/start-ticket-import.dto';
import { ExportRequestService, ExportRequestDto } from '../common/export';
import { CrmSettingsService } from '../crm-settings/crm-settings.service';

@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);
  private readonly importStorage: ImportStorageService;

  constructor(
    private readonly repository: TicketRepository,
    private readonly ticketSettingsService: TicketSettingsService,
    private readonly eventEmitter: EventEmitter2,
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
    private readonly crmSettings: CrmSettingsService,
  ) {
    this.importStorage = this.storageFactory.create('tickets');
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

    const ticket = await this.repository.create({
      ...data,
      ticketNumber,
      isSlaBreached: false,
      timeSpentSeconds: 0,
    } as any);

    // Emit automation event: record_created.Ticket
    this.emitAutomationEvent('record_created', ticket);

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

    // Status transition guard. Custom per-tenant status names mean we can't
    // hard-code an allow-list, but we CAN refuse the one transition that's
    // never intended: leaving a terminal status without an explicit
    // reopen signal. Without this guard, a stale FE state can silently
    // unresolve a closed ticket.
    if (
      data.statusId &&
      existingTicket &&
      (existingTicket as any).statusId &&
      String((existingTicket as any).statusId) !== String(data.statusId)
    ) {
      const [oldStatus, newStatus] = await Promise.all([
        this.ticketSettingsService.findStatusById(
          String((existingTicket as any).statusId),
        ),
        this.ticketSettingsService.findStatusById(data.statusId),
      ]);
      if (oldStatus?.isTerminal && !newStatus?.isTerminal) {
        const allowReopen = (data as any).allowReopen === true;
        if (!allowReopen) {
          throw new BadRequestException(
            `Ticket is in terminal status "${oldStatus.label}". Reopening requires allowReopen=true.`,
          );
        }
      }
      if (newStatus?.isTerminal) {
        if (!data.resolvedAt) updateData.resolvedAt = new Date();
        if (!data.closedAt) updateData.closedAt = new Date();
      }
    } else if (data.statusId) {
      // Status set on a ticket that had no prior status (first transition)
      // — still honour the terminal auto-stamp.
      const status = await this.ticketSettingsService.findStatusById(
        data.statusId,
      );
      if (status?.isTerminal) {
        if (!data.resolvedAt) updateData.resolvedAt = new Date();
        if (!data.closedAt) updateData.closedAt = new Date();
      }
    }

    const updated = await this.repository.update(id, updateData);

    // Emit automation event: field_updated.Ticket
    if (updated) {
      const changedFields = Object.keys(data).filter((k) => k !== 'updatedBy');
      this.emitAutomationEvent('field_updated', updated, changedFields);

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

  async remove(id: string): Promise<void> {
    return this.repository.remove(id);
  }

  // ── Automation Event Emitter ─────────────────────────────────────────────

  private emitAutomationEvent(
    event: 'record_created' | 'field_updated',
    record: Ticket,
    changedFields?: string[],
  ): void {
    const tenantId = this.cls.get('activeTenantId') || this.cls.get('tenantId');
    if (!tenantId) return;

    const payload: AutomationEventPayload = {
      tenantId,
      event,
      object: 'Ticket',
      recordId: record.id,
      data: record as any,
      ...(changedFields ? { changedFields } : {}),
      automationDepth: 0,
    };

    this.eventEmitter.emit(buildAutomationEventName(event, 'Ticket'), payload);
  }

  private getCurrentUserId(): string | undefined {
    return this.cls.get('userId') || this.cls.get('user.id');
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
        entityType: 'ticket',
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
    const tenantId = this.cls.get('activeTenantId') || this.cls.get('tenantId');
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

  // ──────────────────────────── DEAL LINK ────────────────────────────

  /**
   * Link a Deal to this Ticket (bi-directional).
   * Sets ticket.dealId and appends ticket._id to deal.ticketIds[].
   */
  async linkDeal(ticketId: string, dealId: string): Promise<Ticket> {
    const ticket = await this.repository.findOne({ _id: ticketId });
    if (!ticket) throw new NotFoundException('Ticket not found');

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
    if (!ticket) throw new NotFoundException('Ticket not found');

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

    if (!ticket) throw new NotFoundException('Ticket not found');
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
    if (!ticket) throw new NotFoundException('Ticket not found');

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

    // Update target with merged description
    const updated = await this.repository.update(targetId, {
      description: mergedNotes,
    } as any);

    if (!updated)
      throw new NotFoundException('Target ticket not found after update');

    // Soft-delete source ticket (mark as merged via deletedAt)
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

  // \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 SLA PAUSE / RESUME \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  /**
   * Pause the SLA timer for a ticket.
   * Sets slaPausedAt = now, clears slaResumedAt.
   * Idempotent — calling when already paused is a no-op.
   */
  async pauseSla(ticketId: string): Promise<Ticket> {
    const ticket = await this.repository.findOne({ _id: ticketId });
    if (!ticket) throw new NotFoundException('Ticket not found');

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
    if (!ticket) throw new NotFoundException('Ticket not found');

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
