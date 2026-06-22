import { Injectable, Logger } from '@nestjs/common';
import { OmniPayload, ChannelType } from '../domain/omni-payload';
import { OmniReactionPayload } from '../domain/omni-reaction-payload';
import {
  OutboundMedia,
  MediaSendResult,
} from '../../omni-outbound/types/outbound-media.type';
import type { ChannelAdapter } from './channel-adapter.interface';
import { FilesService } from '../../files/files.service';
import { mimeToMessageType } from '../../common/utils/mime.util';
import type { ILivechatGateway } from '../../livechat/interfaces/livechat-gateway.interface';

/**
 * LivechatAdapter — WebSocket-based channel adapter.
 *
 * normalize()       : converts raw widget payload → OmniPayload
 * validateWebhook() : no HTTP webhook — WS auth handled by LivechatGateway
 * send()            : pushes message back to visitor via ILivechatGateway
 * sendMedia()       : resolves fileId → presigned URL, then sends to visitor
 */
@Injectable()
export class LivechatAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'livechat';
  private readonly logger = new Logger(LivechatAdapter.name);
  private gateway: ILivechatGateway | null = null;

  constructor(private readonly filesService: FilesService) {}

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
    // ── Text message ────────────────────────────────────────────────────
    if (rawPayload?.visitorId && rawPayload?.text) {
      return {
        channelType: 'livechat',
        channelId,
        tenantId,
        channelAccount: channelId,
        senderId: rawPayload.visitorId,
        senderType: 'customer',
        messageType: 'text',
        content: rawPayload.text,
        metadata: {
          ...(rawPayload.metadata ?? {}),
          contactName: rawPayload.visitorName || undefined,
        },
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

    // ── Media message (P1.4: fileId already resolved by VisitorUploadService) ──
    // LivechatInboundBridge.handleMediaInbound() uploads base64 → S3 first,
    // then emits rawPayload with { fileId, storageKey }. If upload fails,
    // the bridge returns early — so fileId is always present here.
    if (rawPayload?.visitorId && rawPayload?.fileId) {
      const mimeType: string =
        rawPayload.mimeType ?? 'application/octet-stream';
      const messageType = mimeToMessageType(
        mimeType,
      ) as OmniPayload['messageType'];
      const ts = rawPayload.timestamp
        ? new Date(rawPayload.timestamp)
        : new Date();

      return {
        channelType: 'livechat',
        channelId: rawPayload.channelId ?? channelId,
        tenantId,
        channelAccount: channelId,
        senderId: rawPayload.visitorId,
        senderType: 'customer',
        messageType,
        content: rawPayload.fileName ?? `[${messageType}]`,
        metadata: {
          fileName: rawPayload.fileName,
          mimeType,
          fileSize: rawPayload.fileSize,
          fileId: rawPayload.fileId,
          storageKey: rawPayload.storageKey,
          isVisitorUpload: true,
          contactName: rawPayload.visitorName || undefined,
        },
        externalMessageId: `lc_media_${rawPayload.visitorId}_${ts.getTime()}`,
        externalConversationId: rawPayload.visitorId,
        timestamp: ts,
        providerTimestamp: ts,
      };
    }

    return null;
  }

  /** No HTTP webhook — WS auth is handled in LivechatGateway */
  validateWebhook(): boolean {
    return true;
  }

  async send(
    recipientId: string,
    content: string,
    _messageType: string,
    channelConfig: any,
  ): Promise<any> {
    if (!this.gateway) {
      this.logger.warn(
        'LivechatGateway not set — cannot deliver message to visitor',
      );
      return;
    }
    await this.gateway.sendToVisitor(recipientId, {
      type: 'text',
      content,
      messageId: channelConfig?.messageId,
    });
    return { status: 'sent' };
  }

  /**
   * G2 FIX: Resolve fileId → presigned download URL before emitting to widget.
   *
   * The widget has no authentication context and cannot call /files API itself.
   * We generate a presigned URL server-side (1hr TTL) so the visitor can
   * render images, download files, and play audio/video directly.
   */
  async sendMedia(
    recipientId: string,
    media: OutboundMedia,
    channelConfig: any,
  ): Promise<MediaSendResult> {
    if (!this.gateway) return { success: false, error: 'Gateway not set' };

    let resolvedUrl: string | undefined;
    let thumbnailUrl: string | undefined;

    // Resolve presigned URL from file record.
    // Livechat media always has fileId (set by OutboundService.sendAgentMedia).
    if (media.fileId) {
      try {
        const file = await this.filesService.findById(media.fileId);
        if (file?.path) {
          resolvedUrl = await this.filesService.getPresignedDownloadUrl(
            file.path,
            3600, // 1 hour TTL — sufficient for widget session
          );
          // Resolve thumbnail if available (for video/image)
          if (file.thumbnailKey) {
            thumbnailUrl = await this.filesService.getPresignedDownloadUrl(
              file.thumbnailKey,
              3600,
            );
          }
        } else {
          this.logger.warn(
            `File ${media.fileId} not found in DB — cannot resolve URL`,
          );
        }
      } catch (err: any) {
        this.logger.error(
          `Failed to resolve presigned URL for file ${media.fileId}: ${err?.message}`,
        );
      }
    }

    await this.gateway.sendToVisitor(recipientId, {
      type: 'media',
      url: resolvedUrl,
      mimeType: media.mimeType,
      fileName: media.fileName,
      fileSize: media.size,
      thumbnailUrl,
      messageId: channelConfig?.messageId,
    });

    return { success: true };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Extract a reaction event from a livechat widget payload.
   * The widget emits { messageId, emoji, visitorId, action? }.
   */
  normalizeReaction(
    rawPayload: any,
    tenantId: string,
    channelId: string,
  ): OmniReactionPayload | null {
    if (!rawPayload.messageId || !rawPayload.emoji) return null;

    return {
      tenantId,
      channelId,
      channelType: 'livechat',
      externalMessageId: rawPayload.messageId,
      senderId: rawPayload.visitorId ?? rawPayload.senderId ?? 'visitor',
      senderType: rawPayload.senderType ?? 'customer',
      emoji: rawPayload.emoji,
      action: rawPayload.action ?? 'react',
      timestamp: new Date(),
    };
  }

  /**
   * Send an interactive button message to the visitor widget.
   * Used by OutboundService when bot sends buttons.
   */
  async sendInteractive(
    recipientId: string,
    body: string,
    buttons: Array<{ id: string; title: string }>,
    channelConfig: any,
  ): Promise<any> {
    if (!this.gateway) {
      this.logger.warn('LivechatGateway not set — cannot send interactive');
      return;
    }
    await this.gateway.sendToVisitor(recipientId, {
      type: 'interactive',
      content: body,
      buttons,
      messageId: channelConfig?.messageId,
    });
    return { status: 'sent' };
  }

  /**
   * Send a carousel message to the visitor widget.
   */
  async sendCarousel(
    recipientId: string,
    content: string | undefined,
    cards: any[],
  ): Promise<any> {
    if (!this.gateway) {
      this.logger.warn('LivechatGateway not set — cannot send carousel');
      return;
    }
    await this.gateway.sendToVisitor(recipientId, {
      type: 'carousel',
      content,
      cards,
    });
    return { status: 'sent' };
  }
}
