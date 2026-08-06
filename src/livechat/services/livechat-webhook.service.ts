import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { LivechatWidgetService } from '../livechat-widget.service';
import { createHmac } from 'crypto';
import { CrmEvents, OmniEvents } from '../../omni-inbound/domain/omni-events';

/**
 * LivechatWebhookService
 *
 * Dispatches HTTP POST webhooks to the URL configured in widget.advanced.webhookUrl.
 * Listens to internal events and matches them against widget.advanced.webhookEvents.
 *
 * Event mapping:
 *   Internal Event Name                    → Webhook Event
 *   livechat.message.inbound               → message.received
 *   livechat.visitor.identified             → visitor.identified
 *   omni.conversation.customer.updated      → (no webhook — internal enrichment)
 *
 * Webhook payload is signed with HMAC-SHA256 if webhookSecret is configured.
 * Header: X-CRM-Signature: sha256=<hex>
 *
 * Non-blocking: webhook failures are logged but never throw to the caller.
 */
@Injectable()
export class LivechatWebhookService {
  private readonly logger = new Logger(LivechatWebhookService.name);

  constructor(private readonly widgetService: LivechatWidgetService) {}

  // Event Listeners

  @OnEvent('livechat.message.inbound', { async: true })
  async onMessageReceived(payload: {
    tenantId: string;
    channelId: string;
    widgetId?: string;
    visitorId: string;
    conversationId?: string;
    content: string;
    type?: string;
  }) {
    await this.dispatch(payload.widgetId, 'message.received', {
      event: 'message.received',
      conversationId: payload.conversationId,
      visitorId: payload.visitorId,
      message: {
        content: payload.content,
        type: payload.type ?? 'text',
        sender: 'visitor',
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * The four listeners below hang off the platform's real domain events.
   *
   * They previously listened for `livechat.message.outbound`,
   * `livechat.conversation.started`, `livechat.conversation.ended` and
   * `livechat.csat.submitted` — four event names with **no emitter anywhere**. So a
   * widget configured to receive `message.sent`, `conversation.started`,
   * `conversation.ended` or `csat.submitted` received none of them, while
   * `message.received` and `visitor.identified` worked; the webhook looked
   * partially broken in a way no log explained.
   *
   * Retargeted rather than given four new emitters: the events already exist and
   * are already correct, and a second event that only this consumer listens to is
   * the same trap again.
   */
  @OnEvent(OmniEvents.MESSAGE_SENT, { async: true })
  async onMessageSent(payload: {
    tenantId: string;
    conversationId?: string;
    channelType?: string;
    channelId?: string;
    senderId?: string;
    senderType?: string;
    content: string;
    messageType?: string;
  }) {
    if (payload.channelType !== 'livechat') return;

    await this.dispatchByChannel(
      payload.tenantId,
      payload.channelId,
      'message.sent',
      {
        event: 'message.sent',
        conversationId: payload.conversationId,
        message: {
          content: payload.content,
          type: payload.messageType ?? 'text',
          sender: payload.senderType ?? 'agent',
          agentId:
            payload.senderType === 'agent' ? payload.senderId : undefined,
          timestamp: new Date().toISOString(),
        },
      },
    );
  }

  @OnEvent(OmniEvents.CONVERSATION_CREATED, { async: true })
  async onConversationStarted(payload: {
    tenantId: string;
    conversationId?: string;
    conversation?: { id?: string; channelType?: string; channelId?: string };
  }) {
    const conversation = payload.conversation;
    if (conversation?.channelType !== 'livechat') return;

    await this.dispatchByChannel(
      payload.tenantId,
      conversation.channelId,
      'conversation.started',
      {
        event: 'conversation.started',
        conversationId: conversation.id ?? payload.conversationId,
        timestamp: new Date().toISOString(),
      },
    );
  }

  @OnEvent(OmniEvents.CONVERSATION_STATUS_CHANGED, { async: true })
  async onConversationEnded(payload: {
    tenantId: string;
    conversationId: string;
    channelType?: string;
    channelId?: string;
    status?: string;
    newStatus?: string;
  }) {
    if (payload.channelType !== 'livechat') return;
    const status = payload.newStatus ?? payload.status;
    if (status !== 'resolved' && status !== 'closed') return;

    await this.dispatchByChannel(
      payload.tenantId,
      payload.channelId,
      'conversation.ended',
      {
        event: 'conversation.ended',
        conversationId: payload.conversationId,
        status,
        timestamp: new Date().toISOString(),
      },
    );
  }

  @OnEvent(CrmEvents.CSAT_SUBMITTED, { async: true })
  async onCsatSubmitted(payload: {
    tenantId: string;
    conversationId: string;
    channelType?: string;
    channelId?: string;
    score?: number;
    comment?: string;
  }) {
    if (payload.channelType !== 'livechat') return;

    await this.dispatchByChannel(
      payload.tenantId,
      payload.channelId,
      'csat.submitted',
      {
        event: 'csat.submitted',
        conversationId: payload.conversationId,
        rating: payload.score,
        comment: payload.comment,
        timestamp: new Date().toISOString(),
      },
    );
  }

  /**
   * Dispatch to every widget on a channel.
   *
   * Omni events name the channel, not the widget, and a channel can carry more
   * than one widget (`{channelId, name}` is the unique key, not `channelId`).
   */
  private async dispatchByChannel(
    tenantId: string,
    channelId: string | undefined,
    eventType: string,
    payload: Record<string, any>,
  ): Promise<void> {
    if (!channelId) return;
    try {
      const widgets = await this.widgetService.findByChannel(
        tenantId,
        channelId,
      );
      await Promise.all(
        widgets.map((widget) => this.dispatch(widget.id, eventType, payload)),
      );
    } catch (error) {
      this.logger.warn(
        `Could not resolve widgets for channel ${channelId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  @OnEvent('livechat.visitor.identified', { async: true })
  async onVisitorIdentified(payload: {
    widgetId?: string;
    visitorId: string;
    identityData: Record<string, string>;
  }) {
    await this.dispatch(payload.widgetId, 'visitor.identified', {
      event: 'visitor.identified',
      visitorId: payload.visitorId,
      identity: payload.identityData,
      timestamp: new Date().toISOString(),
    });
  }

  // Core Dispatch

  /**
   * Dispatch a webhook POST if:
   * 1. widgetId is provided
   * 2. Widget has a webhookUrl configured
   * 3. The event is in the widget's webhookEvents list
   */
  private async dispatch(
    widgetId: string | undefined,
    eventType: string,
    payload: Record<string, any>,
  ): Promise<void> {
    if (!widgetId) return;

    try {
      const widget = await this.widgetService.getCachedWidget(widgetId);
      if (!widget) return;

      const webhookUrl = widget.advanced?.webhookUrl;
      if (!webhookUrl) return;

      // Check if this event type is subscribed
      const subscribedEvents = widget.advanced?.webhookEvents ?? [];
      if (
        subscribedEvents.length > 0 &&
        !subscribedEvents.includes(eventType)
      ) {
        return;
      }

      const body = JSON.stringify({
        ...payload,
        widgetId,
        tenantId: widget.tenantId,
      });

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'CRM-Webhook/1.0',
        'X-CRM-Event': eventType,
        'X-CRM-Widget-Id': widgetId,
      };

      // HMAC signature
      const secret = widget.advanced?.webhookSecret;
      if (secret) {
        const signature = createHmac('sha256', secret)
          .update(body)
          .digest('hex');
        headers['X-CRM-Signature'] = `sha256=${signature}`;
      }

      // Fire-and-forget with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        if (!response.ok) {
          this.logger.warn(
            `Webhook ${eventType} → ${webhookUrl} returned ${response.status}`,
          );
        } else {
          this.logger.debug(
            `Webhook ${eventType} → ${webhookUrl} dispatched (${response.status})`,
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err: any) {
      // Non-blocking: log and swallow
      this.logger.warn(
        `Webhook dispatch failed for ${eventType}: ${err.message}`,
      );
    }
  }
}
