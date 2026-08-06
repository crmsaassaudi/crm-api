import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TicketMessagesService } from './ticket-messages.service';
import { TicketEvents, TicketStatusChangedEvent } from './domain/ticket-events';

/**
 * Payload of `assignment.decided`, published by the assignment outbox.
 *
 * Bound to the name the publisher actually emits rather than an invented
 * `ticket.assigned`: a listener on a name nobody emits is the exact defect that
 * left ticket auto-assignment dead while looking connected.
 */
interface AssignmentDecidedEvent {
  tenantId: string;
  objectType: string;
  entityId: string;
  decision: {
    outcome: string;
    assigneeId: string | null;
    groupId: string | null;
    strategy: string;
    reason: string;
  };
}

/**
 * Writes the system half of a ticket's timeline.
 *
 * The `body` here is an English fallback for exports and search; the UI renders
 * from `systemPayload` so the line reads in the viewer's language. Keeping both
 * avoids the two failure modes of picking one: a payload-only entry is blank in
 * a CSV export, and a sentence-only entry is frozen in whatever language the
 * server ran in.
 */
@Injectable()
export class TicketTimelineListener {
  constructor(private readonly messages: TicketMessagesService) {}

  @OnEvent('ticket.created', { async: true })
  async onCreated(event: {
    tenantId?: string;
    entityId?: string;
    newSnapshot?: Record<string, any>;
  }): Promise<void> {
    if (!event.tenantId || !event.entityId) return;
    await this.messages.appendSystem({
      tenantId: event.tenantId,
      ticketId: event.entityId,
      body: 'Ticket created',
      payload: {
        event: 'created',
        channel: event.newSnapshot?.channel ?? null,
        source: event.newSnapshot?.sourceId ?? null,
      },
    });
  }

  @OnEvent(TicketEvents.STATUS_CHANGED, { async: true })
  async onStatusChanged(event: TicketStatusChangedEvent): Promise<void> {
    await this.messages.appendSystem({
      tenantId: event.tenantId,
      ticketId: event.ticketId,
      body: event.isReopen
        ? `Ticket reopened as "${event.nextStatus.label}"`
        : `Status changed to "${event.nextStatus.label}"`,
      payload: {
        event: event.isReopen ? 'reopened' : 'status_changed',
        fromStatusId: event.previousStatus?.id ?? null,
        fromLabel: event.previousStatus?.label ?? null,
        toStatusId: event.nextStatus.id,
        toLabel: event.nextStatus.label,
        terminalKind: event.nextStatus.terminalKind ?? null,
        actorId: event.actorId,
      },
    });
  }

  @OnEvent('assignment.decided', { async: true })
  async onAssigned(event: AssignmentDecidedEvent): Promise<void> {
    if (event.objectType !== 'Ticket') return;
    const { decision } = event;
    await this.messages.appendSystem({
      tenantId: event.tenantId,
      ticketId: event.entityId,
      body: decision.assigneeId
        ? 'Ticket assigned'
        : `Ticket queued (${decision.reason})`,
      payload: {
        event: decision.assigneeId ? 'assigned' : 'queued',
        assigneeId: decision.assigneeId,
        groupId: decision.groupId,
        strategy: decision.strategy,
        outcome: decision.outcome,
      },
    });
  }
}
