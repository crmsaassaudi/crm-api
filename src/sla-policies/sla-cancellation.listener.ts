import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SlaMonitorService } from './sla-monitor.service';

/**
 * SlaCancellationListener — cancels SLA breach-check jobs when they are
 * no longer needed:
 *
 *   1. Agent sends an outbound message → first_response SLA is satisfied
 *   2. Conversation is resolved/closed → no need to check SLA anymore
 *
 * This ensures zero false-positive breaches and cleans up delayed jobs
 * from the BullMQ queue.
 */
@Injectable()
export class SlaCancellationListener {
  private readonly logger = new Logger(SlaCancellationListener.name);

  constructor(private readonly slaMonitorService: SlaMonitorService) {}

  /**
   * When an agent sends a reply, the first_response SLA is satisfied.
   * Cancel the breach-check job so it never fires.
   */
  @OnEvent('omni.outbound.message.sent')
  async handleOutboundMessage(event: {
    tenantId: string;
    conversationId: string;
    senderType?: string;
  }): Promise<void> {
    // Only cancel SLA when an agent (not a bot/system) replies
    if (event.senderType && event.senderType !== 'agent') {
      return;
    }

    try {
      await this.slaMonitorService.cancelSlaBreachCheck(event.conversationId);
      this.logger.debug(
        `SLA breach check cancelled for conversation ${event.conversationId} ` +
          `(agent responded)`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to cancel SLA on agent reply for ${event.conversationId}: ${err.message}`,
      );
    }
  }

  /**
   * When a conversation is resolved or closed, clean up any pending
   * SLA breach-check job — the conversation is no longer active.
   */
  @OnEvent('omni.conversation.status_changed')
  async handleStatusChanged(event: {
    tenantId: string;
    conversationId: string;
    status: string;
  }): Promise<void> {
    if (event.status !== 'resolved' && event.status !== 'closed') {
      return;
    }

    try {
      await this.slaMonitorService.cancelSlaBreachCheck(event.conversationId);
      this.logger.debug(
        `SLA breach check cancelled for conversation ${event.conversationId} ` +
          `(status changed to ${event.status})`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to cancel SLA on status change for ${event.conversationId}: ${err.message}`,
      );
    }
  }
}
