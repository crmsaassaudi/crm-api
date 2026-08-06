import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SlaClockService } from '../../sla-policies/clock/sla-clock.service';
import {
  TicketEvents,
  TicketRepliedEvent,
  TicketStatusChangedEvent,
} from '../domain/ticket-events';

/**
 * Drives the SLA clock from the ticket's lifecycle.
 *
 * Everything the omni side gets from conversation events, tickets now get from
 * their own: a clock opens when the ticket is created, settles when an agent
 * posts a public reply, pauses while the ticket sits in a status the tenant
 * marked `pausesSla` ("Waiting on customer"), completes on a terminal status,
 * and starts a fresh cycle on reopen.
 *
 * A thin translator on purpose — every decision it could make instead belongs
 * to the engine, which is what keeps there being one engine.
 */
@Injectable()
export class TicketSlaProjector {
  constructor(private readonly clocks: SlaClockService) {}

  @OnEvent('ticket.created', { async: true })
  async onCreated(event: {
    tenantId?: string;
    entityId?: string;
  }): Promise<void> {
    if (!event.tenantId || !event.entityId) return;
    await this.clocks.startResponseAndResolutionClocks(event.tenantId, {
      type: 'ticket',
      id: event.entityId,
    });
  }

  /**
   * A public reply settles whichever response clock was owed.
   *
   * `REPLIED`, not `FIRST_RESPONDED`: after the customer answers again the
   * ticket owes a `next_response`, and binding to the first-response event
   * would leave every later turn measured but never met.
   */
  @OnEvent(TicketEvents.REPLIED, { async: true })
  async onReplied(event: TicketRepliedEvent): Promise<void> {
    await this.clocks.onAgentTurn(
      event.tenantId,
      { type: 'ticket', id: event.ticketId },
      event.respondedAt,
    );
  }

  @OnEvent(TicketEvents.CUSTOMER_REPLIED, { async: true })
  async onCustomerReplied(event: TicketRepliedEvent): Promise<void> {
    await this.clocks.onCustomerTurn(event.tenantId, {
      type: 'ticket',
      id: event.ticketId,
    });
  }

  @OnEvent(TicketEvents.STATUS_CHANGED, { async: true })
  async onStatusChanged(event: TicketStatusChangedEvent): Promise<void> {
    const subject = { type: 'ticket' as const, id: event.ticketId };

    if (event.isReopen) {
      // Cancel the settled cycle first. Without that, `startMetric` sees a
      // once-per-subject clock already resolved, refuses to restart, and the
      // reopened ticket carries the old cycle's expired deadline — breaching
      // the instant it comes back.
      await this.clocks.restartCycle(event.tenantId, subject);
      return;
    }

    if (event.nextStatus.isTerminal) {
      await this.clocks.complete(event.tenantId, subject);
      return;
    }

    if (event.nextStatus.pausesSla) {
      await this.clocks.pause(event.tenantId, subject);
    } else if (event.previousStatus?.pausesSla) {
      await this.clocks.resume(event.tenantId, subject);
    }
  }
}
