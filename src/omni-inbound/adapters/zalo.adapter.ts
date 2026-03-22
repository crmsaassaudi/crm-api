import { Injectable } from '@nestjs/common';
import { ChannelAdapter } from './channel-adapter.interface';
import {
  OmniPayload,
  ChannelType,
  MessageType,
} from '../domain/omni-payload';

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

  normalize(
    rawPayload: any,
    tenantId: string,
    channelId: string,
  ): OmniPayload {
    const messageType = this.resolveMessageType(rawPayload.event_name, rawPayload.message);
    const mediaUrl = this.extractMediaUrl(rawPayload.message);

    return {
      tenantId,
      channelId,
      channelAccount: rawPayload.recipient?.id,
      channelType: this.channelType,
      senderId: rawPayload.sender.id,
      senderType: 'customer',
      messageType,
      content: rawPayload.message?.text ?? '',
      mediaUrl: mediaUrl ?? undefined,
      metadata: {
        appId: rawPayload.app_id,
        eventName: rawPayload.event_name,
        oaId: rawPayload.recipient?.id,
        // Keep raw attachment metadata for the media proxy
        attachmentMeta: rawPayload.message?.attachments?.[0]?.payload,
      },
      externalMessageId: rawPayload.message?.msg_id ?? '',
      externalConversationId: `${rawPayload.sender.id}_${rawPayload.recipient?.id}`,
      timestamp: new Date(Number(rawPayload.timestamp)),
    };
  }

  validateWebhook(
    headers: Record<string, string>,
    body: any,
  ): boolean {
    // Zalo uses OA secret key + MAC to verify.
    // Stub: validate `mac` field against computed HMAC.
    const mac = body?.mac;
    if (!mac) return false;
    // TODO: implement HMAC verification with OA secret key
    return true;
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

  async send(
    recipientId: string,
    content: string,
    messageType: string,
    channelConfig: any,
  ): Promise<any> {
    // TODO: implement Zalo OA API call
    console.log(`[Zalo] Sending ${messageType} to ${recipientId}: ${content}`);
    return { message_id: `zalo_out_${Date.now()}` };
  }
}
