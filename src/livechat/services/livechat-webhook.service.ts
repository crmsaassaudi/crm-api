import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { LivechatWidgetService } from '../livechat-widget.service';
import { createHmac } from 'crypto';

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

  // ── Event Listeners ───────────────────────────────────────────────────────

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

  @OnEvent('livechat.message.outbound', { async: true })
  async onMessageSent(payload: {
    widgetId?: string;
    conversationId?: string;
    visitorId?: string;
    content: string;
    type?: string;
    agentId?: string;
  }) {
    await this.dispatch(payload.widgetId, 'message.sent', {
      event: 'message.sent',
      conversationId: payload.conversationId,
      visitorId: payload.visitorId,
      message: {
        content: payload.content,
        type: payload.type ?? 'text',
        sender: 'agent',
        agentId: payload.agentId,
        timestamp: new Date().toISOString(),
      },
    });
  }

  @OnEvent('livechat.conversation.started', { async: true })
  async onConversationStarted(payload: {
    widgetId?: string;
    conversationId: string;
    visitorId: string;
  }) {
    await this.dispatch(payload.widgetId, 'conversation.started', {
      event: 'conversation.started',
      conversationId: payload.conversationId,
      visitorId: payload.visitorId,
      timestamp: new Date().toISOString(),
    });
  }

  @OnEvent('livechat.conversation.ended', { async: true })
  async onConversationEnded(payload: {
    widgetId?: string;
    conversationId: string;
    visitorId: string;
  }) {
    await this.dispatch(payload.widgetId, 'conversation.ended', {
      event: 'conversation.ended',
      conversationId: payload.conversationId,
      visitorId: payload.visitorId,
      timestamp: new Date().toISOString(),
    });
  }

  @OnEvent('livechat.csat.submitted', { async: true })
  async onCsatSubmitted(payload: {
    widgetId?: string;
    conversationId: string;
    visitorId?: string;
    rating: number;
    comment?: string;
  }) {
    await this.dispatch(payload.widgetId, 'csat.submitted', {
      event: 'csat.submitted',
      conversationId: payload.conversationId,
      visitorId: payload.visitorId,
      rating: payload.rating,
      comment: payload.comment,
      timestamp: new Date().toISOString(),
    });
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

  // ── Core Dispatch ─────────────────────────────────────────────────────────

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
