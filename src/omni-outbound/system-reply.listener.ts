import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { OutboundService } from './outbound.service';
import { OmniEvents } from '../omni-inbound/domain/omni-events';
import { runWithTenantContext } from '../common/tenancy/tenant-context';
import { canChannel } from '../omni-inbound/domain/channel-capabilities';

/**
 * SystemReplyListener — delivers the messages the platform sends on its own
 * behalf, with no agent and no bot flow behind them.
 *
 * Two features depended on this and neither worked: the out-of-office auto-reply
 * emitted `omni.ooo.auto_reply` and the auto-resolve warning emitted
 * `omni.auto_resolve.warning`, and **neither event had a listener anywhere**.
 * Both call sites logged that they had sent the message. So a tenant could
 * configure "reply outside business hours", watch the log say `Emitted OOO
 * auto-reply`, and the customer heard nothing — while the conversation was also
 * set to `pending`, which reads as "handled".
 *
 * Sent through `sendBotMessage` so an automated reply is persisted, sequenced and
 * broadcast exactly like every other outbound message: it appears in the
 * transcript the agent reads, which is the point — an agent who cannot see that
 * the system already said "we're closed" will say it again.
 */
@Injectable()
export class SystemReplyListener {
  private readonly logger = new Logger(SystemReplyListener.name);

  constructor(
    private readonly outbound: OutboundService,
    private readonly cls: ClsService,
  ) {}

  @OnEvent(OmniEvents.OOO_AUTO_REPLY, { async: true })
  async handleOutOfOfficeReply(event: {
    tenantId: string;
    conversationId: string;
    channelType: string;
    message: string;
  }): Promise<void> {
    await this.send(event, `ooo:${event.conversationId}:${dayStamp()}`);
  }

  @OnEvent(OmniEvents.AUTO_RESOLVE_WARNING, { async: true })
  async handleAutoResolveWarning(event: {
    tenantId: string;
    conversationId: string;
    channelType: string;
    message: string;
  }): Promise<void> {
    await this.send(event, `auto-resolve-warning:${event.conversationId}`);
  }

  /**
   * Put the CSAT survey link in the conversation.
   *
   * One per conversation: the idempotency key carries no timestamp, so a
   * conversation resolved, reopened and resolved again asks once rather than
   * pestering the customer on every close.
   */
  @OnEvent(OmniEvents.CSAT_SURVEY_REQUESTED, { async: true })
  async handleCsatSurvey(event: {
    tenantId: string;
    conversationId: string;
    channelType: string;
    message: string;
  }): Promise<void> {
    await this.send(event, `csat:${event.conversationId}`);
  }

  /**
   * @param idempotencyKey Deduplicates the send. The out-of-office key includes
   *   the date so a customer messaging on two evenings is told twice, but one who
   *   sends five messages in one evening is told once — the alternative is a bot
   *   arguing with a frustrated customer.
   */
  private async send(
    event: {
      tenantId: string;
      conversationId: string;
      channelType: string;
      message: string;
    },
    idempotencyKey: string,
  ): Promise<void> {
    if (!event.message?.trim()) return;

    // A channel we cannot send on has nowhere to put this. Checked rather than
    // attempted so the failure is one debug line, not a stack trace per message.
    if (!canChannel(event.channelType, 'send')) {
      this.logger.debug(
        `Skipping system reply on ${event.channelType} — channel cannot send`,
      );
      return;
    }

    try {
      await runWithTenantContext(this.cls, event.tenantId, () =>
        this.outbound.sendBotMessage({
          tenantId: event.tenantId,
          conversationId: event.conversationId,
          content: event.message,
          idempotencyKey,
        }),
      );
    } catch (error) {
      // Non-fatal: an automated courtesy message must not fail the inbound
      // pipeline that triggered it. Logged at error level because a customer was
      // promised a reply they did not get.
      this.logger.error(
        `System reply failed for conversation ${event.conversationId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

/** `YYYY-MM-DD` in UTC — the granularity the out-of-office key needs. */
function dayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
