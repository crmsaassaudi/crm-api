import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ChannelAdapter } from '../../omni-inbound/adapters/channel-adapter.interface';
import {
  OmniPayload,
  ChannelType,
  MessageType,
} from '../../omni-inbound/domain/omni-payload';
import {
  OutboundMedia,
  MediaSendResult,
} from '../../omni-outbound/types/outbound-media.type';

const TG_API = (token: string) => `https://api.telegram.org/bot${token}`;

/**
 * TelegramAdapter — Telegram Bot API ↔ OmniChannel pipeline adapter.
 *
 * Inbound:  Telegram Update (webhook) → OmniPayload
 * Outbound: OmniPayload → sendMessage / sendPhoto / sendDocument / sendAudio / sendVideo
 *
 * @see https://core.telegram.org/bots/api
 */
@Injectable()
export class TelegramAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'telegram';
  private readonly logger = new Logger(TelegramAdapter.name);

  // ── normalize ─────────────────────────────────────────────────────────────

  normalize(
    rawPayload: any,
    tenantId: string,
    channelId: string,
    channelConfig?: any,
  ): OmniPayload | null {
    const update = rawPayload;

    // Support message and edited_message
    const msg = update.message ?? update.edited_message;
    if (!msg) {
      this.logger.debug('Telegram update has no message, skipping');
      return null;
    }

    // Skip bot messages (prevent echo loops)
    if (msg.from?.is_bot) {
      this.logger.debug('Telegram message from bot, skipping');
      return null;
    }

    const chatId = String(msg.chat?.id ?? msg.from?.id);
    const fromId = String(msg.from?.id ?? chatId);
    const messageType = this.resolveMessageType(msg);
    const content = this.extractContent(msg);

    return {
      tenantId,
      channelId,
      channelAccount: channelId,
      channelType: this.channelType,
      senderId: fromId,
      senderType: 'customer',
      messageType,
      content,
      mediaUrl: this.extractFileId(msg) ?? undefined,
      metadata: {
        chatId,
        updateId: update.update_id,
        firstName: msg.from?.first_name,
        lastName: msg.from?.last_name,
        username: msg.from?.username,
        languageCode: msg.from?.language_code,
        // For location
        latitude: msg.location?.latitude,
        longitude: msg.location?.longitude,
        // For contact share
        contactPhone: msg.contact?.phone_number,
        contactName: msg.contact?.first_name,
        // For stickers
        stickerEmoji: msg.sticker?.emoji,
        // Bot config passthrough
        bot: channelConfig?.config?.bot ?? channelConfig?.config?.typebot,
        // Store bot token for outbound
        botToken: channelConfig?.credentials?.botToken,
      },
      externalMessageId: String(msg.message_id),
      externalConversationId: chatId,
      timestamp: new Date((msg.date ?? 0) * 1000),
      providerTimestamp: new Date((msg.date ?? 0) * 1000),
    };
  }

  // ── validateWebhook ────────────────────────────────────────────────────────

  /**
   * Telegram does not sign webhook payloads with HMAC by default.
   * We accept from any IP and rely on the secret token (if configured).
   *
   * @see https://core.telegram.org/bots/api#setwebhook (secret_token param)
   */
  validateWebhook(
    headers: Record<string, string>,
    _body: any,
    _rawBody?: Buffer,
  ): boolean {
    // Optional: verify X-Telegram-Bot-Api-Secret-Token header
    const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secretToken) return true; // No secret configured → accept all

    const incomingToken = headers['x-telegram-bot-api-secret-token'];
    if (!incomingToken) {
      this.logger.warn('Telegram webhook missing secret token header');
      return false;
    }
    return incomingToken === secretToken;
  }

  // ── send (text) ────────────────────────────────────────────────────────────

  async send(
    recipientId: string,
    content: string,
    _messageType: string,
    channelConfig: any,
  ): Promise<any> {
    const token = this.extractToken(channelConfig);
    try {
      const response = await axios.post(
        `${TG_API(token)}/sendMessage`,
        {
          chat_id: recipientId,
          text: content,
          parse_mode: 'HTML',
        },
        { timeout: 10_000 },
      );

      const msgId = response.data?.result?.message_id;
      this.logger.log(`Telegram text sent to ${recipientId}: msgId=${msgId}`);
      return { message_id: msgId };
    } catch (err: any) {
      const detail = err?.response?.data?.description ?? err.message;
      this.logger.error(`Failed to send Telegram text: ${detail}`);
      throw new Error(`Telegram send failed: ${detail}`);
    }
  }

  // ── sendMedia ──────────────────────────────────────────────────────────────

  async sendMedia(
    recipientId: string,
    media: OutboundMedia,
    channelConfig: any,
  ): Promise<MediaSendResult> {
    const token = this.extractToken(channelConfig);
    const method = this.mimeToTgMethod(media.mimeType);

    try {
      const form = new FormData();
      form.append('chat_id', recipientId);
      if (media.caption) form.append('caption', media.caption);

      // Use Blob for browser-compatible FormData
      if (media.buffer) {
        const blob = new Blob([new Uint8Array(media.buffer)], {
          type: media.mimeType,
        });
        const fileKey =
          method === 'sendPhoto'
            ? 'photo'
            : method === 'sendAudio'
              ? 'audio'
              : method === 'sendVideo'
                ? 'video'
                : 'document';
        form.append(fileKey, blob, media.fileName || 'file');
      }

      const response = await axios.post(`${TG_API(token)}/${method}`, form, {
        timeout: 30_000,
      });

      const msgId = response.data?.result?.message_id;
      this.logger.log(
        `Telegram ${method} sent to ${recipientId}: msgId=${msgId}`,
      );
      return { success: true, externalMessageId: String(msgId) };
    } catch (err: any) {
      const detail = err?.response?.data?.description ?? err.message;
      this.logger.error(`Failed to send Telegram media: ${detail}`);
      return { success: false, error: `Telegram media send failed: ${detail}` };
    }
  }

  // ── enrichProfile ──────────────────────────────────────────────────────────

  enrichProfile(
    _externalId: string,
    _accessToken: string,
  ): Promise<{ name?: string; avatarUrl?: string }> {
    // Telegram does not provide a user profile API for bots beyond what comes
    // in the webhook update. Return empty — the name is already in normalize().
    return Promise.resolve({});
  }

  // ── PRIVATE HELPERS ────────────────────────────────────────────────────────

  private extractToken(channelConfig: any): string {
    const token = channelConfig?.credentials?.botToken;
    if (!token)
      throw new Error(
        'TelegramAdapter: botToken is missing from channel config',
      );
    return token;
  }

  private resolveMessageType(msg: any): MessageType {
    if (msg.photo?.length) return 'image';
    if (msg.video) return 'video';
    if (msg.audio) return 'audio';
    if (msg.voice) return 'audio';
    if (msg.document) return 'file';
    if (msg.sticker) return 'sticker';
    if (msg.location) return 'location';
    if (msg.contact) return 'text';
    if (msg.animation) return 'video';
    return 'text';
  }

  private extractContent(msg: any): string {
    if (msg.text) return msg.text;
    if (msg.caption) return msg.caption ?? '';
    if (msg.location)
      return `📍 (${msg.location.latitude}, ${msg.location.longitude})`;
    if (msg.contact)
      return `📞 ${msg.contact.first_name} ${msg.contact.phone_number}`;
    if (msg.sticker) return msg.sticker.emoji ?? '🎭';
    if (msg.voice) return '[Voice message]';
    if (msg.video_note) return '[Video note]';
    return '';
  }

  private extractFileId(msg: any): string | null {
    // For photos: last element = best quality
    if (msg.photo?.length)
      return msg.photo[msg.photo.length - 1]?.file_id ?? null;
    if (msg.video) return msg.video.file_id;
    if (msg.audio) return msg.audio.file_id;
    if (msg.voice) return msg.voice.file_id;
    if (msg.document) return msg.document.file_id;
    if (msg.sticker) return msg.sticker.file_id;
    if (msg.animation) return msg.animation.file_id;
    return null;
  }

  private mimeToTgMethod(mimeType: string): string {
    if (mimeType.startsWith('image/')) return 'sendPhoto';
    if (mimeType.startsWith('audio/')) return 'sendAudio';
    if (mimeType.startsWith('video/')) return 'sendVideo';
    return 'sendDocument';
  }
}
