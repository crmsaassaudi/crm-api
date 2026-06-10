import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { ChannelAdapter } from './channel-adapter.interface';
import { OmniPayload, ChannelType, MessageType } from '../domain/omni-payload';
import { WhatsAppTemplateRepository } from '../../message-templates/infrastructure/persistence/document/repositories/whatsapp-template.repository';

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
 *     type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'location' | 'sticker',
 *     text?: { body },
 *     image?: { id, mime_type, sha256 },
 *     document?: { id, mime_type, sha256, filename },
 *     audio?: { id, mime_type, sha256 },
 *     video?: { id, mime_type, sha256 },
 *     location?: { latitude, longitude, name, address },
 *     sticker?: { id, mime_type, sha256 },
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
    if (rawPayload.event === 'message_template_status_update') {
      this.logger.log(`Received template status update: ${rawPayload.message_template_name} -> ${rawPayload.current_status}`);
      
      this.waTemplateRepo.updateByName(tenantId, rawPayload.message_template_name, {
        status: rawPayload.current_status,
      }).catch(err => {
        this.logger.error(`Failed to update template status for ${rawPayload.message_template_name}: ${err.message}`);
      });
      
      return null;
    }

    const msg = rawPayload.messages?.[0];
    if (!msg) {
      this.logger.debug('WhatsApp webhook change value has no messages, skipping');
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

  private resolveMessageType(waType: string): MessageType {
    const map: Record<string, MessageType> = {
      text: 'text',
      image: 'image',
      document: 'file',
      audio: 'audio',
      video: 'video',
      location: 'location',
      sticker: 'sticker',
    };
    return map[waType] ?? 'text';
  }

  private extractContent(msg: any): string {
    switch (msg.type) {
      case 'text':
        return msg.text?.body ?? '';
      case 'location':
        return `📍 ${msg.location?.name ?? ''} (${msg.location?.latitude}, ${msg.location?.longitude})`;
      default:
        // For media messages, content is typically empty or a caption
        return msg[msg.type]?.caption ?? '';
    }
  }

  private extractMediaId(msg: any): string | null {
    if (msg.type === 'text' || msg.type === 'location') return null;
    return msg[msg.type]?.id ?? null;
  }

  private extractMimeType(msg: any): string | null {
    if (msg.type === 'text' || msg.type === 'location') return null;
    return msg[msg.type]?.mime_type ?? null;
  }

  private resolveBotConfig(
    channelConfig?: any,
  ): Record<string, any> | undefined {
    const config = channelConfig?.config ?? {};
    return config.bot ?? config.typebot ?? undefined;
  }

  send(
    recipientId: string,
    content: string,
    messageType: string,
    channelConfig: any,
  ): Promise<any> {
    void channelConfig;
    // TODO: implement WA Cloud API call
    this.logger.log(
      `[WhatsApp] Sending ${messageType} to ${recipientId}: ${content}`,
    );
    return Promise.resolve({ message_id: `wa_out_${Date.now()}` });
  }
}
