import { Injectable } from '@nestjs/common';
import { TicketRepository } from './infrastructure/persistence/document/repositories/ticket.repository';
import { Ticket } from './domain/ticket';
import { TicketSettingsService } from '../ticket-settings/ticket-settings.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  AutomationEventPayload,
  buildAutomationEventName,
} from '../automation-rules/events/automation-event.payload';

@Injectable()
export class TicketsService {
  constructor(
    private readonly repository: TicketRepository,
    private readonly ticketSettingsService: TicketSettingsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService,
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

    // Auto-set timestamps based on terminal status
    if (data.statusId) {
      const status = await this.ticketSettingsService.findStatusById(
        data.statusId,
      );
      if (status?.isTerminal) {
        if (!data.resolvedAt) {
          updateData.resolvedAt = new Date();
        }
        if (!data.closedAt) {
          updateData.closedAt = new Date();
        }
      }
    }

    const updated = await this.repository.update(id, updateData);

    // Emit automation event: field_updated.Ticket
    if (updated) {
      const changedFields = Object.keys(data).filter((k) => k !== 'updatedBy');
      this.emitAutomationEvent('field_updated', updated, changedFields);

      // Emit audit trail event: field-level change tracking
      this.eventEmitter.emit('ticket.updated', {
        t: new Date(),
        tenantId:
          this.cls.get('activeTenantId') || this.cls.get('tenantId'),
        entityId: id,
        entityType: 'TICKET',
        oldSnapshot: existingTicket
          ? JSON.parse(JSON.stringify(existingTicket))
          : {},
        newSnapshot: JSON.parse(JSON.stringify(updated)),
        actorId: this.getCurrentUserId(),
        src: this.cls.get('executionSource') || 'M',
        ctx: this.cls.get('sourceContext'),
        ip: this.cls.get('requestIp'),
        ua: this.cls.get('userAgent'),
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
