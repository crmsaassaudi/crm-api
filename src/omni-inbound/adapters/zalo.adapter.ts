import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import axios from 'axios';
import { ChannelAdapter } from './channel-adapter.interface';
import { OmniPayload, ChannelType, MessageType } from '../domain/omni-payload';

/** Zalo Official Account Open API v3. */
const ZALO_OA_API = 'https://openapi.zalo.me/v3.0/oa';

/**
 * Deterministic JSON serializer. Sorts object keys recursively so two payloads
 * with identical content but different key insertion orders produce identical
 * bytes — necessary for HMAC signature verification to be stable.
 */
function stringifyCanonical(value: any): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stringifyCanonical(v)).join(',') + ']';
  }
  const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + stringifyCanonical(value[k]))
      .join(',') +
    '}'
  );
}

/**
 * Zalo OA webhook → OmniPayload adapter.
 *
 * Reference: https://developers.zalo.me/docs/official-account/webhook
 *
 * Incoming shape (simplified):
 * {
 *   app_id: '<APP_ID>',
 *   sender: { id: '<USER_ID>' },
 *   recipient: { id: '<OA_ID>' },
 *   event_name: 'user_send_text' | 'user_send_image' | 'user_send_file' | …,
 *   message: {
 *     msg_id: '<MSG_ID>',
 *     text?: 'Hello',
 *     attachments?: [{ type, payload: { url, thumbnail?, name?, size? } }]
 *   },
 *   timestamp: '1234567890000'
 * }
 *
 * ⚠️  Zalo media URLs EXPIRE after ~30 minutes.  The media proxy service
 *     must download and cache them before they become invalid.
 */
@Injectable()
export class ZaloAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'zalo';
  private readonly logger = new Logger(ZaloAdapter.name);

  normalize(
    rawPayload: any,
    tenantId: string,
    channelId: string,
    channelConfig?: any,
  ): OmniPayload[] {
    // OA-originated events (`oa_send_*`) are echoes of messages we already
    // stored when we sent them; only user-originated events are new.
    if (!String(rawPayload.event_name ?? '').startsWith('user_send')) {
      return [];
    }

    const oaId = rawPayload.oa_id ?? rawPayload.recipient?.id;
    const userId = rawPayload.sender?.id;
    const sentAt = new Date(Number(rawPayload.timestamp));

    return [
      {
        tenantId,
        channelId,
        channelAccount: oaId,
        channelType: this.channelType,
        senderId: userId,
        senderType: 'customer',
        messageType: this.resolveMessageType(
          rawPayload.event_name,
          rawPayload.message,
        ),
        content: rawPayload.message?.text ?? '',
        mediaUrl: this.extractMediaUrl(rawPayload.message) ?? undefined,
        metadata: {
          appId: rawPayload.app_id,
          eventName: rawPayload.event_name,
          oaId,
          // Keep raw attachment metadata for the media proxy
          attachmentMeta: rawPayload.message?.attachments?.[0]?.payload,
          bot: this.resolveBotConfig(channelConfig),
        },
        externalMessageId: rawPayload.message?.msg_id ?? '',
        externalConversationId: `${userId}_${oaId}`,
        timestamp: sentAt,
        providerTimestamp: sentAt,
      },
    ];
  }

  /**
   * Verify the Zalo webhook MAC signature.
   *
   * Zalo OA signs webhook payloads using HMAC-SHA256 with the OA Secret Key.
   * The `mac` field in the body contains the computed signature.
   *
   * @see https://developers.zalo.me/docs/official-account/webhook/webhook-security
   */
  validateWebhook(
    headers: Record<string, string>,
    body: any,
    _rawBody?: Buffer,
    secret?: string,
  ): boolean {
    // headers and _rawBody are intentionally unused (underscore-prefixed params)
    const mac = body?.mac;
    if (!mac) {
      this.logger.warn('Zalo webhook missing mac field');
      return false;
    }

    // Each Zalo OA has its own secret, so the channel's own value wins over
    // the env fallback — otherwise only one tenant's OA could ever verify.
    const oaSecretKey =
      secret ??
      process.env.ZALO_OA_SECRET_KEY ??
      process.env.ZALO_WEBHOOK_SECRET;
    if (!oaSecretKey) {
      this.logger.error(
        'ZALO_OA_SECRET_KEY is not configured — cannot verify Zalo webhook',
      );
      return false;
    }

    // Zalo MAC is computed over specific payload fields (excluding the `mac` field itself).
    // Use a canonical (sorted-key) JSON serializer so the signature is stable
    // regardless of how the JSON parser ordered keys.
    const { mac: _mac, ...payloadWithoutMac } = body;
    const dataToSign = stringifyCanonical(payloadWithoutMac);
    const expectedMac = createHmac('sha256', oaSecretKey)
      .update(dataToSign)
      .digest('hex');

    try {
      return timingSafeEqual(Buffer.from(mac), Buffer.from(expectedMac));
    } catch {
      return false;
    }
  }

  private resolveMessageType(eventName: string, message: any): MessageType {
    switch (eventName) {
      case 'user_send_text':
        return 'text';
      case 'user_send_image':
        return 'image';
      case 'user_send_file':
        return 'file';
      case 'user_send_audio':
        return 'audio';
      case 'user_send_video':
        return 'video';
      case 'user_send_sticker':
        return 'sticker';
      case 'user_send_location':
        return 'location';
      default:
        // Fallback: sniff from attachment type
        return this.sniffFromAttachment(message) ?? 'text';
    }
  }

  private sniffFromAttachment(message: any): MessageType | null {
    const attachment = message?.attachments?.[0];
    if (!attachment) return null;
    const typeMap: Record<string, MessageType> = {
      image: 'image',
      file: 'file',
      audio: 'audio',
      video: 'video',
      sticker: 'sticker',
    };
    return typeMap[attachment.type] ?? 'file';
  }

  private extractMediaUrl(message: any): string | null {
    const attachment = message?.attachments?.[0];
    return attachment?.payload?.url ?? attachment?.payload?.thumbnail ?? null;
  }

  private resolveBotConfig(
    channelConfig?: any,
  ): Record<string, any> | undefined {
    const config = channelConfig?.config ?? {};
    return config.bot ?? config.typebot ?? undefined;
  }

  /**
   * Send a text message through the Zalo OA API.
   *
   * @see https://developers.zalo.me/docs/official-account/tin-nhan/gui-tin-nhan-tu-van
   */
  async send(
    recipientId: string,
    content: string,
    _messageType: string,
    channelConfig: any,
  ): Promise<{ message_id: string }> {
    const accessToken = channelConfig?.credentials?.accessToken;
    if (!accessToken) {
      throw new Error('Zalo adapter lacks an access token to send messages');
    }

    const response = await axios.post(
      `${ZALO_OA_API}/message/cs`,
      {
        recipient: { user_id: recipientId },
        message: { text: content },
      },
      {
        headers: {
          access_token: accessToken,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      },
    );

    // Zalo answers 200 with an `error` field rather than an HTTP error code, so
    // a non-zero `error` has to be turned into a throw explicitly — otherwise
    // every rejected send would be recorded as delivered.
    const body = response.data;
    if (body?.error) {
      throw new Error(
        `Zalo send failed (${body.error}): ${body.message ?? 'unknown error'}`,
      );
    }

    return { message_id: body?.data?.message_id ?? '' };
  }
}
