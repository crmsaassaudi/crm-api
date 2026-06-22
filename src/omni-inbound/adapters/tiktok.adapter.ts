import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { ChannelAdapter } from './channel-adapter.interface';
import { OmniPayload, ChannelType, MessageType } from '../domain/omni-payload';

/**
 * TikTok Direct Messages / TikTok Business Messaging webhook → OmniPayload adapter.
 *
 * TikTok Business API shape (simplified):
 * https://developers.tiktok.com/doc/webhooks-events
 *
 * Incoming event envelope (type: direct_message):
 * {
 *   client_key: '<CLIENT_KEY>',
 *   type: 'direct_message',
 *   event: {
 *     conversation_id: '<CONV_ID>',
 *     create_time: 1700000000000,
 *     from_user: { open_id: '<SENDER_OPEN_ID>', display_name: '<NAME>' },
 *     to_user:   { open_id: '<RECIPIENT_OPEN_ID>' },
 *     message: {
 *       message_id: '<MSG_ID>',
 *       message_type: 'text' | 'image' | 'video' | 'audio' | 'sticker' | 'file',
 *       content: {
 *         text?: '<BODY>',
 *         image_url?: '<URL>',
 *         video_url?: '<URL>',
 *         audio_url?: '<URL>',
 *         file_url?: '<URL>',
 *         sticker_url?: '<URL>',
 *       }
 *     }
 *   }
 * }
 *
 * Webhook verification: TikTok sends an HMAC-SHA256 signature in the
 * `X-TikTok-Signature` header computed over the raw request body with the
 * app's client secret.
 */
@Injectable()
export class TikTokAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'tiktok';
  private readonly logger = new Logger(TikTokAdapter.name);

  normalize(
    rawPayload: any,
    tenantId: string,
    channelId: string,
    channelConfig?: any,
  ): OmniPayload {
    const event = rawPayload?.event ?? {};
    const msg = event?.message ?? {};
    const fromUser = event?.from_user ?? {};

    const messageType = this.resolveMessageType(msg.message_type);
    const mediaUrl = this.extractMediaUrl(msg);

    return {
      tenantId,
      channelId,
      channelAccount: event?.to_user?.open_id ?? rawPayload.client_key ?? '',
      channelType: this.channelType,
      senderId: fromUser.open_id ?? '',
      senderType: 'customer',
      messageType,
      content: msg.content?.text ?? '',
      mediaUrl: mediaUrl ?? undefined,
      metadata: {
        clientKey: rawPayload.client_key,
        eventType: rawPayload.type,
        displayName: fromUser.display_name,
        conversationId: event.conversation_id,
        bot: this.resolveBotConfig(channelConfig),
      },
      externalMessageId: msg.message_id ?? '',
      externalConversationId: event.conversation_id ?? '',
      timestamp: new Date(Number(event.create_time) || Date.now()),
      providerTimestamp: new Date(Number(event.create_time) || Date.now()),
    };
  }

  /**
   * Verify TikTok webhook signature.
   *
   * TikTok computes the signature as:
   *   HMAC-SHA256(client_secret, raw_body)
   * and sends it in the `X-TikTok-Signature` header.
   *
   * @see https://developers.tiktok.com/doc/webhooks-security
   */
  validateWebhook(
    headers: Record<string, string>,
    _body: any,
    rawBody?: Buffer,
  ): boolean {
    const signature =
      headers['x-tiktok-signature'] ?? headers['X-TikTok-Signature'];

    if (!signature) {
      this.logger.warn('[TikTok] Missing X-TikTok-Signature header');
      return false;
    }

    const clientSecret =
      process.env.TIKTOK_CLIENT_SECRET ?? process.env.TIKTOK_WEBHOOK_SECRET;

    if (!clientSecret) {
      this.logger.error(
        '[TikTok] TIKTOK_CLIENT_SECRET is not configured — cannot verify webhook',
      );
      return false;
    }

    if (!rawBody) {
      this.logger.warn('[TikTok] rawBody not provided; skipping HMAC check');
      return true; // permissive fallback when raw buffer not forwarded
    }

    const expected = createHmac('sha256', clientSecret)
      .update(rawBody)
      .digest('hex');

    try {
      return timingSafeEqual(
        Buffer.from(signature.replace(/^sha256=/, '')),
        Buffer.from(expected),
      );
    } catch {
      return false;
    }
  }

  /**
   * Webhook challenge verification (GET request from TikTok to confirm endpoint).
   * Returns true when the payload contains the echo challenge field.
   */
  handleChallenge(body: any): string | null {
    return body?.challenge ?? null;
  }

  send(
    recipientId: string,
    content: string,
    messageType: string,
    _channelConfig: any,
  ): Promise<any> {
    // TikTok Business Messaging send API requires access token which is
    // managed per channel-config. Full send support is deferred to H11.
    throw new Error(
      `[TikTok] Send not implemented — cannot deliver ${messageType} to ${recipientId}. ` +
        'Configure TIKTOK_ACCESS_TOKEN and implement send() when TikTok Business API access is granted.',
    );
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private resolveMessageType(tiktokType: string | undefined): MessageType {
    switch (tiktokType) {
      case 'text':
        return 'text';
      case 'image':
        return 'image';
      case 'video':
        return 'video';
      case 'audio':
        return 'audio';
      case 'sticker':
        return 'sticker';
      case 'file':
        return 'file';
      default:
        return 'text';
    }
  }

  private extractMediaUrl(msg: any): string | null {
    const c = msg?.content ?? {};
    return (
      c.image_url ??
      c.video_url ??
      c.audio_url ??
      c.file_url ??
      c.sticker_url ??
      null
    );
  }

  private resolveBotConfig(
    channelConfig?: any,
  ): Record<string, any> | undefined {
    const cfg = channelConfig?.config ?? {};
    return cfg.bot ?? cfg.typebot ?? undefined;
  }
}
