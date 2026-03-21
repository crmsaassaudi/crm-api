import { Injectable } from '@nestjs/common';
import { ChannelAdapter } from './channel-adapter.interface';
import {
  OmniPayload,
  ChannelType,
  MessageType,
} from '../domain/omni-payload';

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

  normalize(
    rawPayload: any,
    tenantId: string,
    channelId: string,
  ): OmniPayload {
    const msg = rawPayload.messages?.[0];
    if (!msg) {
      throw new Error('WhatsApp webhook has no messages');
    }

    const contact = rawPayload.contacts?.[0];
    const messageType = this.resolveMessageType(msg.type);

    return {
      tenantId,
      channelId,
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
      },
      externalMessageId: msg.id,
      externalConversationId: `${msg.from}_${rawPayload.metadata?.phone_number_id}`,
      timestamp: new Date(Number(msg.timestamp) * 1000),
    };
  }

  validateWebhook(
    headers: Record<string, string>,
    body: any,
  ): boolean {
    // WhatsApp Cloud API uses the same X-Hub-Signature-256 as Facebook.
    const signature = headers['x-hub-signature-256'];
    if (!signature) return false;
    // TODO: verify HMAC with app secret
    return true;
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

  async send(
    recipientId: string,
    content: string,
    messageType: string,
    channelConfig: any,
  ): Promise<any> {
    // TODO: implement WA Cloud API call
    console.log(`[WhatsApp] Sending ${messageType} to ${recipientId}: ${content}`);
    return { message_id: `wa_out_${Date.now()}` };
  }
}
