import { BadRequestException, Injectable } from '@nestjs/common';
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

@Injectable()
export class TicketsService {
  constructor(
    private readonly repository: TicketRepository,
    private readonly ticketSettingsService: TicketSettingsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService,
    private readonly entityAudit: EntityAuditService,
  ) {}

  async create(data: Partial<Ticket>): Promise<Ticket> {
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const groupId = data.groupId === '' ? undefined : data.groupId;
    const ticketNumber = await this.repository.generateTicketNumber();

    const ticket = await this.repository.create({
      ...data,
      ticketNumber,
      ownerId,
      groupId,
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

    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const groupId = data.groupId === '' ? undefined : data.groupId;

    const updateData: any = { ...data, ownerId, groupId };

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
            `Ticket is in terminal status "${oldStatus.name}". Reopening requires allowReopen=true.`,
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
}
