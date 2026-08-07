import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { OmniEvents } from '../../omni-inbound/domain/omni-events';
import { TicketEvents } from '../domain/ticket-events';
import { TicketRepository } from '../infrastructure/persistence/document/repositories/ticket.repository';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';

/**
 * The missing half of `TicketEvents.CUSTOMER_REPLIED`.
 *
 * `TicketSlaProjector.onCustomerReplied` has listened for it since the ticket SLA
 * engine was built, and nothing ever emitted it — the conversation's own SLA
 * subject resumes on a customer message (`SlaClockService.onInboundMessage`), but
 * a ticket linked to that conversation is a *second*, independent SLA subject
 * (`{type:'ticket', id}`) with no wire back to the conversation it came from. A
 * ticket left open across a customer's follow-up message never had its
 * `next_response` clock resumed, so it could sit un-breached indefinitely for a
 * reply that had, in fact, already arrived.
 */
@Injectable()
export class TicketConversationReplyListener {
  private readonly logger = new Logger(TicketConversationReplyListener.name);

  constructor(
    private readonly tickets: TicketRepository,
    private readonly events: EventEmitter2,
    private readonly cls: ClsService,
  ) {}

  @OnEvent(OmniEvents.MESSAGE_PERSISTED, { async: true })
  async onMessagePersisted(event: {
    tenantId?: string;
    conversationId?: string;
    senderType?: string;
    messageId?: string;
    internalMessageId?: string;
    timestamp?: string | Date;
    providerTimestamp?: string | Date;
  }): Promise<void> {
    if (event.senderType !== 'customer') return;
    if (!event.tenantId || !event.conversationId) return;

    const respondedAt = new Date(
      event.providerTimestamp ?? event.timestamp ?? Date.now(),
    );

    await runWithTenantContext(this.cls, event.tenantId, async () => {
      const linked = await this.tickets.find({
        omniConversationId: event.conversationId,
        deletedAt: null,
        closedAt: null,
      });

      for (const ticket of linked) {
        this.events.emit(TicketEvents.CUSTOMER_REPLIED, {
          tenantId: event.tenantId,
          ticketId: ticket.id,
          messageId: event.internalMessageId ?? event.messageId ?? '',
          authorId: null,
          respondedAt,
        });
      }
    }).catch((error: unknown) => {
      this.logger.error(
        `Failed to resume ticket SLA clocks for conversation=${event.conversationId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}
