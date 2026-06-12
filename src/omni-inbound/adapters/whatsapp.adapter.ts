import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import axios from 'axios';
import FormData from 'form-data';
import { ChannelAdapter } from './channel-adapter.interface';
import { OmniPayload, ChannelType, MessageType } from '../domain/omni-payload';
import {
  OutboundMedia,
  MediaSendResult,
} from '../../omni-outbound/types/outbound-media.type';
import { WhatsAppTemplateRepository } from '../../message-templates/infrastructure/persistence/document/repositories/whatsapp-template.repository';

/** Graph API version. Centralized to ease upgrades. */
const WA_GRAPH_VERSION = 'v19.0';

/**
 * Classify WhatsApp Cloud API error codes into actionable categories.
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
function classifyWaError(errorCode: number | undefined): string {
  switch (errorCode) {
    case 131047:
      return 'REPLY_WINDOW_EXPIRED';
    case 131051:
      return 'UNSUPPORTED_MESSAGE_TYPE';
    case 131053:
      return 'MEDIA_DOWNLOAD_FAILED';
    case 130472:
      return 'RECIPIENT_NOT_ON_WHATSAPP';
    case 131031:
      return 'RECIPIENT_PHONE_INVALID';
    case 131056:
      return 'RATE_LIMITED_PAIR';
    case 80007:
      return 'RATE_LIMITED_GLOBAL';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Strip access tokens and secrets from Graph API error responses
 * before logging to prevent credential leakage.
 */
function sanitizeWaError(value: any): any {
  if (value == null || typeof value !== 'object') return value;
  const clone: Record<string, any> = Array.isArray(value) ? [] : {};
  for (const [k, v] of Object.entries(value)) {
    if (/token|secret|access|password/i.test(k)) {
      clone[k] = '[REDACTED]';
    } else {
      clone[k] = sanitizeWaError(v);
    }
  }
  return clone;
}

/**
 * WhatsApp Cloud API webhook → OmniPayload adapter.
 *
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
 *
 * Incoming shape (simplified — the controller unwraps `entry[].changes[].value`):
 * {
 *   messaging_product: 'whatsapp',
 *   metadata: { phone_number_id, display_phone_number },
 *   contacts: [{ profile: { name }, wa_id }],
 *   messages: [{
 *     from: '<WA_ID>',
 *     id: '<MSG_ID>',
 *     timestamp: '<UNIX>',
 *     type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'location' | 'sticker' | 'button' | 'interactive' | 'reaction',
 *     text?: { body },
 *     image?: { id, mime_type, sha256 },
 *     document?: { id, mime_type, sha256, filename },
 *     audio?: { id, mime_type, sha256 },
 *     video?: { id, mime_type, sha256 },
 *     location?: { latitude, longitude, name, address },
 *     sticker?: { id, mime_type, sha256 },
 *     button?: { text, payload },
 *     interactive?: { type, button_reply?, list_reply? },
 *     reaction?: { message_id, emoji },
 *   }]
 * }
 */
@Injectable()
export class WhatsAppAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'whatsapp';
  private readonly logger = new Logger(WhatsAppAdapter.name);

  constructor(private readonly waTemplateRepo: WhatsAppTemplateRepository) {}

  normalize(
    rawPayload: any,
    tenantId: string,
    channelId: string,
    channelConfig?: any,
  ): OmniPayload | null {
    // ── Template status webhook ─────────────────────────────────────
    if (rawPayload.event === 'message_template_status_update') {
      this.logger.log(`Received template status update: ${rawPayload.message_template_name} -> ${rawPayload.current_status}`);

      this.waTemplateRepo.updateByName(tenantId, rawPayload.message_template_name, {
        status: rawPayload.current_status,
      }).catch(err => {
        this.logger.error(`Failed to update template status for ${rawPayload.message_template_name}: ${err.message}`);
      });

      return null;
    }

    // ── Status webhooks (delivered / read / failed) ────────────────
    // WhatsApp sends delivery receipts in a `statuses` array.
    // We skip these as non-message events; status tracking can be
    // added later by emitting events instead of returning OmniPayload.
    if (rawPayload.statuses?.length && !rawPayload.messages?.length) {
      this.logger.debug(
        `WhatsApp status update: ${rawPayload.statuses[0]?.status} for msg ${rawPayload.statuses[0]?.id}`,
      );
      return null;
    }

    const msg = rawPayload.messages?.[0];
    if (!msg) {
      this.logger.debug('WhatsApp webhook change value has no messages, skipping');
      return null;
    }

    // ── Skip reaction events (emoji reactions on messages) ─────────
    if (msg.type === 'reaction') {
      this.logger.debug(`WhatsApp reaction ${msg.reaction?.emoji} on ${msg.reaction?.message_id}, skipping`);
      return null;
    }

    const contact = rawPayload.contacts?.[0];
    const messageType = this.resolveMessageType(msg.type);

    return {
      tenantId,
      channelId,
      channelAccount: rawPayload.metadata?.phone_number_id,
      channelType: this.channelType,
      senderId: msg.from,
      senderType: 'customer',
      messageType,
      content: this.extractContent(msg),
      mediaUrl: this.extractMediaId(msg) ?? undefined,
      metadata: {
        phoneNumberId: rawPayload.metadata?.phone_number_id,
        displayPhoneNumber: rawPayload.metadata?.display_phone_number,
        contactName: contact?.profile?.name,
        waId: contact?.wa_id,
        // For media: the WA media ID that must be fetched via Graph API
        mediaId: this.extractMediaId(msg),
        mimeType: this.extractMimeType(msg),
        // Carry the channel's access token so MediaProxyService can
        // download media that requires authentication.
        accessToken: channelConfig?.credentials?.accessToken,
        bot: this.resolveBotConfig(channelConfig),
      },
      externalMessageId: msg.id,
      externalConversationId: `${msg.from}_${rawPayload.metadata?.phone_number_id}`,
      timestamp: new Date(Number(msg.timestamp) * 1000),
      providerTimestamp: new Date(Number(msg.timestamp) * 1000),
    };
  }

  /**
   * Verify the X-Hub-Signature-256 HMAC signature on incoming webhooks.
   *
   * WhatsApp Cloud API uses the same HMAC-SHA256 mechanism as Facebook Messenger.
   * The signature is computed using the Facebook App Secret.
   *
   * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
   */
  validateWebhook(
    headers: Record<string, string>,
    body: any,
    rawBody?: Buffer,
  ): boolean {
    const signature = headers['x-hub-signature-256'];
    if (!signature) {
      this.logger.warn('WhatsApp webhook missing X-Hub-Signature-256 header');
      return false;
    }

    const appSecret =
      process.env.FACEBOOK_APP_SECRET || process.env.META_APP_SECRET;
    if (!appSecret) {
      this.logger.error(
        'FACEBOOK_APP_SECRET is not configured — cannot verify WhatsApp webhook signature',
      );
      return false;
    }

    if (!rawBody) {
      this.logger.error(
        'WhatsApp webhook missing rawBody — refusing to validate against a re-serialized payload',
      );
      return false;
    }
    const expectedSignature =
      'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');

    try {
      return timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature),
      );
    } catch {
      return false;
    }
  }

  /**
   * Send a text message via WhatsApp Cloud API.
   *
   * @param recipientId  The customer's WhatsApp phone number (e.g. '966501234567')
   * @param content      Message text
   * @param messageType  'text' (only text is sent here; use sendMedia for others)
   * @param channelConfig  { credentials: { accessToken }, account: phoneNumberId }
   *
   * @see https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages
   */
  async send(
    recipientId: string,
    content: string,
    messageType: string,
    channelConfig: any,
  ): Promise<any> {
    const accessToken = channelConfig?.credentials?.accessToken;
    if (!accessToken) {
      throw new Error('WhatsApp adapter lacks access token to send message');
    }

    const phoneNumberId = channelConfig?.account;
    if (!phoneNumberId) {
      throw new Error('WhatsApp adapter lacks phone_number_id (channel account)');
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientId,
      type: 'text',
      text: { body: content },
    };

    try {
      const response = await axios.post(
        `https://graph.facebook.com/${WA_GRAPH_VERSION}/${phoneNumberId}/messages`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 10_000,
        },
      );

      const waMessageId = response.data?.messages?.[0]?.id;
      this.logger.log(
        `WhatsApp text sent to ${recipientId}: messageId=${waMessageId}`,
      );
      return { message_id: waMessageId };
    } catch (err: any) {
      const errorData = sanitizeWaError(err?.response?.data ?? err.message);
      const errorCode = err?.response?.data?.error?.code;
      const errorCategory = classifyWaError(errorCode);
      this.logger.error(
        `Failed to send WhatsApp text [${errorCategory}]: ${JSON.stringify(errorData)}`,
      );
      throw new Error(
        `Failed to send WhatsApp message [${errorCategory}]: ${JSON.stringify(errorData)}`,
      );
    }
  }

  /**
   * Send a media message via WhatsApp Cloud API.
   *
   * Flow:
   * 1. Upload media buffer to WhatsApp Media API → get media_id
   * 2. Send message referencing the media_id
   *
   * @see https://developers.facebook.com/docs/whatsapp/cloud-api/messages/media-messages
   */
  async sendMedia(
    recipientId: string,
    media: OutboundMedia,
    channelConfig: any,
  ): Promise<MediaSendResult> {
    const accessToken = channelConfig?.credentials?.accessToken;
    if (!accessToken) {
      return { success: false, error: 'WhatsApp adapter lacks access token' };
    }

    const phoneNumberId = channelConfig?.account;
    if (!phoneNumberId) {
      return { success: false, error: 'WhatsApp adapter lacks phone_number_id' };
    }

    if (!media.buffer) {
      return { success: false, error: 'Media buffer is required for WhatsApp' };
    }

    try {
      // ── Step 1: Upload media to WhatsApp ────────────────────────────
      const mediaId = await this.uploadMedia(
        phoneNumberId,
        accessToken,
        media.buffer,
        media.mimeType,
        media.fileName,
      );

      // ── Step 2: Send media message ──────────────────────────────────
      const waMediaType = this.mimeToWaMediaType(media.mimeType);
      const mediaPayload: Record<string, any> = { id: mediaId };

      // Add caption for image/video (documents use filename instead)
      if (media.caption && (waMediaType === 'image' || waMediaType === 'video')) {
        mediaPayload.caption = media.caption;
      }
      // Documents should include the filename
      if (waMediaType === 'document') {
        mediaPayload.filename = media.fileName || 'file';
        if (media.caption) {
          mediaPayload.caption = media.caption;
        }
      }

      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipientId,
        type: waMediaType,
        [waMediaType]: mediaPayload,
      };

      const response = await axios.post(
        `https://graph.facebook.com/${WA_GRAPH_VERSION}/${phoneNumberId}/messages`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 15_000,
        },
      );

      const waMessageId = response.data?.messages?.[0]?.id;
      this.logger.log(
        `WhatsApp ${waMediaType} sent to ${recipientId}: messageId=${waMessageId}, mediaId=${mediaId}`,
      );

      return {
        success: true,
        externalMessageId: waMessageId,
        externalMediaId: mediaId,
      };
    } catch (err: any) {
      const errorData = sanitizeWaError(err?.response?.data ?? err.message);
      const errorCode = err?.response?.data?.error?.code;
      const errorCategory = classifyWaError(errorCode);
      this.logger.error(
        `Failed to send WhatsApp media [${errorCategory}]: ${JSON.stringify(errorData)}`,
      );
      return {
        success: false,
        error: `WhatsApp media send failed [${errorCategory}]: ${JSON.stringify(errorData)}`,
      };
    }
  }

  /**
   * Upload a media file to WhatsApp Cloud API.
   *
   * @returns The WhatsApp media ID to reference in a message
   * @see https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media#upload-media
   */
  private async uploadMedia(
    phoneNumberId: string,
    accessToken: string,
    buffer: Buffer,
    mimeType: string,
    fileName: string,
  ): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', buffer, {
      filename: fileName || 'file',
      contentType: mimeType,
    });

    const response = await axios.post(
      `https://graph.facebook.com/${WA_GRAPH_VERSION}/${phoneNumberId}/media`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: 30_000, // Media uploads can be slow for large files
      },
    );

    const mediaId = response.data?.id;
    if (!mediaId) {
      throw new Error('WhatsApp media upload succeeded but no media ID returned');
    }

    this.logger.log(
      `WhatsApp media uploaded: ${fileName} (${(buffer.length / 1024).toFixed(0)}KB) → mediaId=${mediaId}`,
    );
    return mediaId;
  }

  /**
   * Map MIME type to WhatsApp Cloud API media type.
   *
   * WhatsApp supports: image, video, audio, document, sticker
   * @see https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media#supported-media-types
   */
  private mimeToWaMediaType(
    mimeType: string,
  ): 'image' | 'video' | 'audio' | 'document' | 'sticker' {
    if (mimeType === 'image/webp') return 'sticker';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'document';
  }

  private resolveMessageType(waType: string): MessageType {
    const map: Record<string, MessageType> = {
      text: 'text',
      image: 'image',
      document: 'file',
      audio: 'audio',
      video: 'video',
      location: 'location',
      sticker: 'sticker',
      // Interactive message types
      button: 'text',
      interactive: 'text',
      contacts: 'text',
      order: 'text',
    };
    return map[waType] ?? 'text';
  }

  private extractContent(msg: any): string {
    switch (msg.type) {
      case 'text':
        return msg.text?.body ?? '';
      case 'location':
        return `📍 ${msg.location?.name ?? ''} (${msg.location?.latitude}, ${msg.location?.longitude})`;
      case 'button':
        // Quick-reply button tap: { text, payload }
        return msg.button?.text ?? '';
      case 'interactive':
        // Interactive button or list reply
        return (
          msg.interactive?.button_reply?.title ??
          msg.interactive?.list_reply?.title ??
          msg.interactive?.list_reply?.description ??
          ''
        );
      case 'contacts':
        // Contact card sharing
        return msg.contacts?.[0]?.name?.formatted_name ?? '[Contact card]';
      case 'order':
        return '[Order]';
      default:
        // For media messages, content is typically empty or a caption
        return msg[msg.type]?.caption ?? '';
    }
  }

  private extractMediaId(msg: any): string | null {
    if (msg.type === 'text' || msg.type === 'location' || msg.type === 'button' || msg.type === 'interactive' || msg.type === 'contacts' || msg.type === 'order' || msg.type === 'reaction') return null;
    return msg[msg.type]?.id ?? null;
  }

  private extractMimeType(msg: any): string | null {
    if (msg.type === 'text' || msg.type === 'location' || msg.type === 'button' || msg.type === 'interactive' || msg.type === 'contacts' || msg.type === 'order' || msg.type === 'reaction') return null;
    return msg[msg.type]?.mime_type ?? null;
  }

  private resolveBotConfig(
    channelConfig?: any,
  ): Record<string, any> | undefined {
    const config = channelConfig?.config ?? {};
    return config.bot ?? config.typebot ?? undefined;
  }

  /**
   * Send a pre-approved WhatsApp template message via Cloud API.
   *
   * Template messages bypass the 24-hour reply window and are the only
   * way to initiate a conversation or re-engage after the window expires.
   *
   * @param recipientId   WhatsApp phone number (e.g. '966501234567')
   * @param templateName  Template name as registered on Meta (e.g. 'welcome_message')
   * @param languageCode  BCP-47 language code (e.g. 'vi', 'en_US', 'ar')
   * @param components    Template component parameters (header, body, buttons)
   * @param channelConfig { credentials: { accessToken }, account: phoneNumberId }
   *
   * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates
   */
  async sendTemplate(
    recipientId: string,
    templateName: string,
    languageCode: string,
    components: any[],
    channelConfig: any,
  ): Promise<{ message_id: string }> {
    const accessToken = channelConfig?.credentials?.accessToken;
    if (!accessToken) {
      throw new Error('WhatsApp adapter lacks access token to send template');
    }

    const phoneNumberId = channelConfig?.account;
    if (!phoneNumberId) {
      throw new Error('WhatsApp adapter lacks phone_number_id (channel account)');
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientId,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components: components?.length ? components : undefined,
      },
    };

    try {
      const response = await axios.post(
        `https://graph.facebook.com/${WA_GRAPH_VERSION}/${phoneNumberId}/messages`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 10_000,
        },
      );

      const waMessageId = response.data?.messages?.[0]?.id;
      this.logger.log(
        `WhatsApp template '${templateName}' sent to ${recipientId}: messageId=${waMessageId}`,
      );
      return { message_id: waMessageId };
    } catch (err: any) {
      const errorData = sanitizeWaError(err?.response?.data ?? err.message);
      const errorCode = err?.response?.data?.error?.code;
      const errorCategory = classifyWaError(errorCode);
      this.logger.error(
        `Failed to send WhatsApp template [${errorCategory}]: ${JSON.stringify(errorData)}`,
      );
      throw new Error(
        `Failed to send WhatsApp template [${errorCategory}]: ${JSON.stringify(errorData)}`,
      );
    }
  }
}
