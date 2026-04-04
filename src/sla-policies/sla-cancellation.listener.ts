import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SlaMonitorService } from './sla-monitor.service';

/**
 * SlaCancellationListener — cancels SLA breach-check jobs when they are
 * no longer needed:
 *
 *   1. Agent sends outbound message → cancel FRT job (first response satisfied)
 *   2. Conversation resolved/closed → cancel both FRT and Resolution jobs
 */
@Injectable()
export class SlaCancellationListener {
  private readonly logger = new Logger(SlaCancellationListener.name);

  constructor(private readonly slaMonitorService: SlaMonitorService) {}

  /**
   * When an agent sends a reply, the first_response SLA is satisfied.
   * Cancel the FRT breach-check job. Resolution job keeps running.
   */
  @OnEvent('omni.outbound.message.sent')
  async handleOutboundMessage(event: {
    tenantId: string;
    conversationId: string;
    senderType?: string;
  }): Promise<void> {
    // Only cancel FRT when an agent (not a bot/system) replies
    if (event.senderType && event.senderType !== 'agent') {
      return;
    }

    try {
      await this.slaMonitorService.cancelFrtBreachCheck(event.conversationId);
      this.logger.debug(
        `FRT SLA cancelled for conversation ${event.conversationId} (agent responded)`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to cancel FRT for ${event.conversationId}: ${err.message}`,
      );
    }
  }

  /**
   * When a conversation is resolved or closed, clean up ALL pending
   * SLA breach-check jobs — both FRT and Resolution.
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
      await this.slaMonitorService.cancelAllBreachChecks(event.conversationId);
      this.logger.debug(
        `All SLA jobs cancelled for conversation ${event.conversationId} (${event.status})`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to cancel SLA on status change for ${event.conversationId}: ${err.message}`,
      );
    }
  }
}
