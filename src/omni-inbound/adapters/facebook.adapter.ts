import { Injectable } from '@nestjs/common';
import { ChannelAdapter } from './channel-adapter.interface';
import {
  OmniPayload,
  ChannelType,
  MessageType,
} from '../domain/omni-payload';
import axios from 'axios';

/**
 * Facebook Messenger webhook → OmniPayload adapter.
 *
 * Reference: https://developers.facebook.com/docs/messenger-platform/webhooks
 *
 * Incoming shape (simplified):
 * {
 *   object: 'page',
 *   entry: [{
 *     id: '<PAGE_ID>',
 *     time: 1234567890,
 *     messaging: [{
 *       sender:    { id: '<PSID>' },
 *       recipient: { id: '<PAGE_ID>' },
 *       timestamp: 1234567890,
 *       message: {
 *         mid: '<MSG_ID>',
 *         text: 'Hello!',
 *         attachments?: [{ type, payload: { url } }]
 *       }
 *     }]
 *   }]
 * }
 */
@Injectable()
export class FacebookAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'facebook';

  normalize(
    rawPayload: any,
    tenantId: string,
    channelId: string,
  ): OmniPayload {
    // FB batches events — we normalise the first messaging entry.
    // The controller should iterate `entry[].messaging[]` and call this once per event.
    const messaging = rawPayload;
    const isEcho = !!messaging.message?.is_echo;
    const pageId = isEcho ? messaging.sender.id : messaging.recipient.id;
    const consumerId = isEcho ? messaging.recipient.id : messaging.sender.id;

    const messageType = this.resolveMessageType(messaging.message);
    const mediaUrl = this.extractMediaUrl(messaging.message);

    return {
      tenantId,
      channelId,
      channelAccount: pageId,
      channelType: this.channelType,
      senderId: messaging.sender.id,
      senderType: isEcho ? 'agent' : 'customer',
      messageType,
      content: messaging.message?.text ?? '',
      mediaUrl: mediaUrl ?? undefined,
      metadata: {
        mid: messaging.message?.mid,
        quickReply: messaging.message?.quick_reply,
        replyTo: messaging.message?.reply_to,
        isEcho,
      },
      externalMessageId: messaging.message?.mid ?? '',
      externalConversationId: `${consumerId}_${pageId}`,
      timestamp: new Date(messaging.timestamp),
    };
  }

  validateWebhook(
    headers: Record<string, string>,
    body: any,
  ): boolean {
    // In production, verify X-Hub-Signature-256 header with app secret.
    // Stub: always true for now — implement HMAC verification when app secret is configured.
    const signature = headers['x-hub-signature-256'];
    if (!signature) return false;
    // TODO: crypto.timingSafeEqual(computedHmac, providedHmac)
    return true;
  }

  private resolveMessageType(message: any): MessageType {
    if (!message) return 'text';
    if (message.text && !message.attachments) return 'text';

    const attachment = message.attachments?.[0];
    if (!attachment) return 'text';

    switch (attachment.type) {
      case 'image':
        return 'image';
      case 'video':
        return 'video';
      case 'audio':
        return 'audio';
      case 'file':
        return 'file';
      case 'template':
        return 'template';
      default:
        return 'file';
    }
  }

  private extractMediaUrl(message: any): string | null {
    const attachment = message?.attachments?.[0];
    return attachment?.payload?.url ?? null;
  }

  async send(
    recipientId: string,
    content: string,
    messageType: string,
    channelConfig: any,
  ): Promise<any> {
    const accessToken = channelConfig?.credentials?.accessToken;
    if (!accessToken) {
      throw new Error('Facebook adapter lacks access token to send message');
    }

    const pageId = channelConfig?.account || 'me';

    const payload: any = {
      recipient: { id: recipientId },
      messaging_type: 'RESPONSE',
      message: { text: content },
    };

    try {
      const response = await axios.post(
        `https://graph.facebook.com/v19.0/${pageId}/messages`,
        payload,
        { params: { access_token: accessToken } }
      );
      return { message_id: response.data.message_id };
    } catch (err: any) {
      const errorData = err?.response?.data || err.message;
      console.error('[Facebook Adapter Error]', errorData);
      throw new Error(`Failed to send message via Facebook: ${JSON.stringify(errorData)}`);
    }
  }
}
