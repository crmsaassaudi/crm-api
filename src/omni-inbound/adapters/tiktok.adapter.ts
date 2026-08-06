import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import axios from 'axios';
import { ChannelAdapter } from './channel-adapter.interface';
import { OmniPayload, ChannelType, MessageType } from '../domain/omni-payload';

const TIKTOK_BUSINESS_API = 'https://business-api.tiktok.com/open_api/v1.3';

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
  ): OmniPayload[] {
    const event = rawPayload?.event ?? {};
    const msg = event?.message ?? {};
    const fromUser = event?.from_user ?? {};

    const messageType = this.resolveMessageType(msg.message_type);
    const mediaUrl = this.extractMediaUrl(msg);

    return [
      {
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
      },
    ];
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
    secret?: string,
  ): boolean {
    const signature =
      headers['x-tiktok-signature'] ?? headers['X-TikTok-Signature'];

    if (!signature) {
      this.logger.warn('[TikTok] Missing X-TikTok-Signature header');
      return false;
    }

    // Per-app secret when the channel carries one; env is the single-app case.
    const clientSecret =
      secret ??
      process.env.TIKTOK_CLIENT_SECRET ??
      process.env.TIKTOK_WEBHOOK_SECRET;

    if (!clientSecret) {
      this.logger.error(
        '[TikTok] TIKTOK_CLIENT_SECRET is not configured — cannot verify webhook',
      );
      return false;
    }

    // Fail closed. The previous `return true` here meant any request that
    // arrived without the raw body — the one condition an attacker controls by
    // choosing a content type Express does not buffer — skipped verification
    // entirely, which is the whole signature check turned off by omission.
    if (!rawBody) {
      this.logger.error(
        '[TikTok] rawBody unavailable — cannot verify signature, rejecting',
      );
      return false;
    }

    const expected = createHmac('sha256', clientSecret)
      .update(rawBody)
      .digest('hex');

    try {
      const received = Buffer.from(signature.replace(/^sha256=/, ''), 'hex');
      const expectedBuffer = Buffer.from(expected, 'hex');
      // timingSafeEqual throws on a length mismatch, which a forged signature of
      // the wrong length would trigger — compare lengths first so that reads as
      // "invalid" rather than as an exception.
      return (
        received.length === expectedBuffer.length &&
        timingSafeEqual(received, expectedBuffer)
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

  /**
   * Send a direct message through the TikTok Business Messaging API.
   *
   * This used to throw unconditionally. Combined with a webhook that could not
   * resolve an account, TikTok was a channel a tenant could switch on and then
   * lose every customer through: messages arrived nowhere and replies failed.
   *
   * Errors are surfaced by throwing, which is what `DeliveryProcessor` needs to
   * mark the attempt failed and retry — a resolved promise is recorded as
   * delivered.
   */
  async send(
    recipientId: string,
    content: string,
    _messageType: string,
    channelConfig: any,
  ): Promise<{ message_id: string }> {
    const accessToken = channelConfig?.credentials?.accessToken;
    if (!accessToken) {
      throw new Error('TikTok adapter lacks an access token to send messages');
    }

    const response = await axios.post(
      `${TIKTOK_BUSINESS_API}/message/send/`,
      {
        to_user: { open_id: recipientId },
        message: { message_type: 'text', content: { text: content } },
      },
      {
        headers: {
          'Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      },
    );

    // TikTok answers HTTP 200 with a non-zero `code` on rejection, so the error
    // has to be raised explicitly — otherwise every refused send is recorded as
    // delivered and the customer is never told anything went wrong.
    const body = response.data;
    if (body?.code && body.code !== 0) {
      throw new Error(
        `TikTok send failed (${body.code}): ${body.message ?? 'unknown error'}`,
      );
    }

    return { message_id: body?.data?.message_id ?? '' };
  }

  // Private helpers

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
