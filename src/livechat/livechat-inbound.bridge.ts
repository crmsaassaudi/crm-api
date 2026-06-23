import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LivechatGateway } from './livechat.gateway';
import { VisitorUploadService } from './visitor-upload.service';
import { mimeToMessageType } from '../common/utils/mime.util';
import { OmniEvents, LivechatEvents } from '../omni-inbound/domain/omni-events';

/**
 * LivechatInboundBridge — routes visitor messages into the OmniInbound pipeline
 * and propagates conversation lifecycle events back to the visitor widget.
 *
 * Decouples LivechatGateway from OmniInboundModule via EventEmitter.
 *
 * Events consumed:
 *  - livechat.message.inbound  : text message from visitor → omni.inbound.webhook
 *  - livechat.media.inbound    : file upload from visitor → omni.inbound.webhook
 *  - omni.message.persisted    : after InboundProcessor saves → push conversationId to widget
 */
@Injectable()
export class LivechatInboundBridge {
  private readonly logger = new Logger(LivechatInboundBridge.name);

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly livechatGateway: LivechatGateway,
    private readonly visitorUploadService: VisitorUploadService,
  ) {}

  // ── P1.2 FIX: handle text messages ─────────────────────────────────────

  @OnEvent(LivechatEvents.MESSAGE_INBOUND)
  handleTextInbound(payload: {
    visitorId: string;
    tenantId: string;
    channelId: string;
    text: string;
    timestamp: string;
    visitorName: string;
    metadata?: Record<string, any>;
  }) {
    this.logger.debug(
      `Livechat text inbound from visitor ${payload.visitorId}`,
    );

    this.eventEmitter.emit(OmniEvents.INBOUND_WEBHOOK, {
      channelType: 'livechat',
      channelId: payload.channelId,
      tenantId: payload.tenantId,
      rawPayload: {
        visitorId: payload.visitorId,
        visitorName: payload.visitorName,
        text: payload.text,
        timestamp: payload.timestamp,
        metadata: payload.metadata,
      },
    });
  }

  @OnEvent(LivechatEvents.MEDIA_INBOUND)
  async handleMediaInbound(payload: {
    visitorId: string;
    tenantId: string;
    channelId: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    base64: string;
    timestamp: string;
    visitorName: string;
  }) {
    this.logger.log(
      `Livechat media inbound from visitor ${payload.visitorId}: "${payload.fileName}" (${payload.mimeType})`,
    );

    // ── P1.4 FIX: Upload base64 → S3 BEFORE entering pipeline ──────────────
    // ConversationService does not handle base64. We resolve it here so
    // the OmniPayload has fileId (not raw base64) when saved to MongoDB.
    const dedupeKey = `${payload.tenantId}:${payload.visitorId}:${payload.timestamp}:${payload.fileName}`;
    let fileId: string | undefined;
    let storageKey: string | undefined;

    try {
      const result = await this.visitorUploadService.uploadFromBase64({
        tenantId: payload.tenantId,
        visitorId: payload.visitorId,
        fileName: payload.fileName,
        mimeType: payload.mimeType,
        fileSize: payload.fileSize,
        base64: payload.base64,
        dedupeKey,
      });
      fileId = result.fileId;
      storageKey = result.storageKey;
      
      this.eventEmitter.emit(LivechatEvents.VISITOR_UPLOAD_COMPLETED, {
        tenantId: payload.tenantId,
        visitorId: payload.visitorId,
        fileName: payload.fileName,
        mimeType: payload.mimeType,
      });
    } catch (err: any) {
      this.logger.error(
        `Visitor upload failed for ${payload.visitorId}: ${err?.message}. Skipping media message.`,
      );
      this.eventEmitter.emit(LivechatEvents.VISITOR_UPLOAD_FAILED, {
        tenantId: payload.tenantId,
        visitorId: payload.visitorId,
        fileName: payload.fileName,
        error: err?.message || 'Upload failed',
      });
      return; // do not push broken payload into pipeline
    }

    const messageType = mimeToMessageType(payload.mimeType);

    // Emit into OmniInbound pipeline with fileId — no base64 in DB
    this.eventEmitter.emit(OmniEvents.INBOUND_WEBHOOK, {
      channelType: 'livechat',
      channelId: payload.channelId,
      tenantId: payload.tenantId,
      rawPayload: {
        visitorId: payload.visitorId,
        visitorName: payload.visitorName,
        channelId: payload.channelId,
        messageType,
        fileName: payload.fileName,
        mimeType: payload.mimeType,
        fileSize: payload.fileSize,
        fileId,
        storageKey,
        timestamp: payload.timestamp,
      },
    });
  }

  // ── P1.1 FIX: push conversationId back to visitor widget ─────────────

  /**
   * After InboundProcessor saves the first message for a livechat visitor,
   * an OmniConversation record is created/reused. We then push the
   * conversationId back to the visitor widget so that:
   *
   * 1. visitor:typing events carry the correct conversationId
   * 2. Widget can fetch message history on reconnect
   * 3. LivechatVisitorBridge can route agent events correctly
   *
   * The event payload is the OmniPayload spread + conversationId + messageId.
   * For livechat: payload.senderId = visitorId, payload.channelType = 'livechat'.
   */
  @OnEvent(OmniEvents.MESSAGE_PERSISTED)
  handleMessagePersisted(payload: {
    channelType: string;
    channelId: string;
    tenantId: string;
    senderId: string; // = visitorId for livechat
    senderType: string;
    conversationId: string;
    messageId: string;
    internalMessageId: string;
  }) {
    // Only handle livechat inbound messages from visitor
    if (payload.channelType !== 'livechat') return;
    if (payload.senderType !== 'customer') return; // skip agent messages

    const visitorId = payload.senderId;

    this.logger.debug(
      `[Bridge] Push conversation:linked → visitor ${visitorId}, conv ${payload.conversationId}`,
    );

    // Emit to visitor room — widget updates socket.data.conversationId
    // and can now include it in visitor:typing events
    this.livechatGateway.server
      ?.to(`visitor:${visitorId}`)
      .emit('conversation:linked', {
        conversationId: payload.conversationId,
        visitorId,
      });
  }
}
