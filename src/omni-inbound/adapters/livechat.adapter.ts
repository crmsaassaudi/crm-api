import { Injectable, Logger } from '@nestjs/common';
import { OmniPayload, ChannelType } from '../domain/omni-payload';
import {
  OutboundMedia,
  MediaSendResult,
} from '../../omni-outbound/types/outbound-media.type';
import type { ChannelAdapter } from './channel-adapter.interface';

/** Minimal interface — avoids circular import with LivechatModule */
interface ILivechatGateway {
  sendToVisitor(
    visitorId: string,
    payload:
      | { type: 'text'; content: string }
      | { type: 'media'; fileId?: string; mimeType: string; fileName: string },
  ): Promise<void>;
}

/**
 * LivechatAdapter — WebSocket-based channel adapter.
 *
 * normalize()       : converts raw widget payload → OmniPayload
 * validateWebhook() : no HTTP webhook — WS auth handled by LivechatGateway
 * send()            : pushes message back to visitor via ILivechatGateway
 */
@Injectable()
export class LivechatAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'livechat' as ChannelType;
  private readonly logger = new Logger(LivechatAdapter.name);
  private gateway: ILivechatGateway | null = null;

  /** Called from LivechatModule after both providers are ready — breaks circular DI */
  setGateway(gw: ILivechatGateway): void {
    this.gateway = gw;
  }

  // ── ChannelAdapter contract ─────────────────────────────────────────────

  normalize(
    rawPayload: any,
    tenantId: string,
    channelId: string,
    _channelConfig?: any,
  ): OmniPayload | null {
    if (!rawPayload?.visitorId || !rawPayload?.text) return null;

    return {
      // ── Required OmniPayload fields ──────────────────────────────────
      channelType: 'livechat' as ChannelType,
      channelId,
      tenantId,
      channelAccount: channelId, // no external page/OA id for livechat
      senderId: rawPayload.visitorId, // visitor fingerprint
      senderType: 'customer',
      messageType: 'text',
      content: rawPayload.text,
      metadata: {},
      externalMessageId: `lc_${rawPayload.visitorId}_${Date.now()}`,
      externalConversationId: rawPayload.visitorId,
      timestamp: rawPayload.timestamp
        ? new Date(rawPayload.timestamp)
        : new Date(),
      providerTimestamp: rawPayload.timestamp
        ? new Date(rawPayload.timestamp)
        : new Date(),
    };
  }

  /** No HTTP webhook — WS auth is handled in LivechatGateway */
  validateWebhook(): boolean {
    return true;
  }

  async send(
    recipientId: string,
    content: string,
    _messageType: string,
    _channelConfig: any,
  ): Promise<any> {
    if (!this.gateway) {
      this.logger.warn(
        'LivechatGateway not set — cannot deliver message to visitor',
      );
      return;
    }
    await this.gateway.sendToVisitor(recipientId, { type: 'text', content });
    return { status: 'sent' };
  }

  async sendMedia(
    recipientId: string,
    media: OutboundMedia,
    _channelConfig: any,
  ): Promise<MediaSendResult> {
    if (!this.gateway) return { success: false, error: 'Gateway not set' };

    await this.gateway.sendToVisitor(recipientId, {
      type: 'media',
      fileId: media.fileId,
      mimeType: media.mimeType,
      fileName: media.fileName,
    });
    return { success: true };
  }
}
