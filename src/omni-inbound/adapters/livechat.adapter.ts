import { Injectable, Logger } from '@nestjs/common';
import { OmniPayload, ChannelType } from '../domain/omni-payload';
import {
  OutboundMedia,
  MediaSendResult,
} from '../../omni-outbound/types/outbound-media.type';
import type { ChannelAdapter } from './channel-adapter.interface';
import { FilesService } from '../../files/files.service';

/**
 * G2 FIX: ILivechatGateway now exposes url (pre-resolved presigned URL)
 * instead of fileId, so the visitor widget can render media directly.
 */
interface ILivechatGateway {
  sendToVisitor(
    visitorId: string,
    payload:
      | { type: 'text'; content: string }
      | {
          type: 'media';
          url?: string;
          mimeType: string;
          fileName: string;
          fileSize?: number;
          thumbnailUrl?: string;
        },
  ): void;
}

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
  readonly channelType: ChannelType = 'livechat' as ChannelType;
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
        channelType: 'livechat' as ChannelType,
        channelId,
        tenantId,
        channelAccount: channelId,
        senderId: rawPayload.visitorId,
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

    // ── Media message (P1.4: fileId already resolved by VisitorUploadService) ──
    // LivechatInboundBridge.handleMediaInbound() uploads base64 → S3 first,
    // then emits rawPayload with { fileId, storageKey } instead of base64.
    if (rawPayload?.visitorId && (rawPayload?.fileId || rawPayload?.base64)) {
      const mimeType: string =
        rawPayload.mimeType ?? 'application/octet-stream';
      const messageType = this.mimeToMessageType(
        mimeType,
      ) as OmniPayload['messageType'];
      const ts = rawPayload.timestamp
        ? new Date(rawPayload.timestamp)
        : new Date();

      return {
        channelType: 'livechat' as ChannelType,
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
          // Preferred path: fileId + storageKey (base64 already on S3)
          fileId: rawPayload.fileId,
          storageKey: rawPayload.storageKey,
          // Legacy fallback: raw base64 (only present if VisitorUploadService skipped)
          base64: rawPayload.fileId ? undefined : rawPayload.base64,
          isVisitorUpload: true,
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
    _channelConfig: any,
  ): Promise<MediaSendResult> {
    if (!this.gateway) return { success: false, error: 'Gateway not set' };

    let resolvedUrl: string | undefined;
    let thumbnailUrl: string | undefined;

    // Resolve presigned URL from file record
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
        // Fall through — widget will get undefined url and show fallback
      }
    } else {
      // media.url is not on the OutboundMedia type; handle via any-cast
      const mediaWithUrl = media as any;
      if (mediaWithUrl.url) {
        // Already a public URL (e.g. external media cache)
        resolvedUrl = mediaWithUrl.url;
      }
    }

    await this.gateway.sendToVisitor(recipientId, {
      type: 'media',
      url: resolvedUrl, // ← resolved presigned URL for widget
      mimeType: media.mimeType,
      fileName: media.fileName,
      fileSize: media.size,
      thumbnailUrl,
    });

    return { success: true };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private mimeToMessageType(mimeType: string): string {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'file';
  }
}
