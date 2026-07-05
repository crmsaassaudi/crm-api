import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ConversationRepository } from '../omni-inbound/repositories/conversation.repository';
import { ChannelRepository } from '../channels/infrastructure/persistence/document/repositories/channel.repository';
import { LivechatWidgetService } from './livechat-widget.service';
import { MessageStatusService } from './services/message-status.service';
import { SocketRateLimiter } from '../common/guards/socket-rate-limiter';
import { runWithTenantContext } from '../common/tenancy/tenant-context';
import { OmniEvents, LivechatEvents } from '../omni-inbound/domain/omni-events';

/**
 * LivechatGateway — Socket.IO namespace for livechat visitors.
 *
 * Namespace: /livechat  (public — no JWT required)
 *
 * Livechat là một channel omni như Facebook, WhatsApp, Zalo.
 * Không có session riêng — mọi dữ liệu đều lưu trong OmniConversation.
 *
 *   externalId      = visitorId (browser fingerprint)
 *   channelAccount  = channelId (livechat channel config id)
 *   channelType     = 'livechat'
 *
 * Socket routing: visitor joins room `visitor:{visitorId}`.
 * Gửi message về visitor chỉ cần emit vào room đó — không cần socketId.
 *
 * Event table (Client → Server):
 * ┌────────────────────┬───────────────────────────────────────────────────┐
 * │ visitor:connect    │ Handshake — join room, lưu context vào socket.data │
 * │ visitor:message    │ Text → OmniInbound pipeline                       │
 * │ visitor:upload     │ File (base64) → OmniInbound media pipeline        │
 * │ visitor:typing     │ Typing indicator → forward đến agent CRM          │
 * │ visitor:identify   │ Enrich customer.email / customer.name / phone     │
 * │ visitor:reaction   │ Emoji reaction → unified reaction pipeline        │
 * │ visitor:ack        │ Delivery receipt → mark messages as delivered      │
 * │ visitor:read       │ Read receipt → mark messages as read               │
 * └────────────────────┴───────────────────────────────────────────────────┘
 *
 * Event table (Server → Client):
 * ┌────────────────────┬───────────────────────────────────────────────────┐
 * │ visitor:connected  │ Ack với conversationId (nếu có session cũ)        │
 * │ agent:message      │ Text hoặc media từ agent                          │
 * │ agent:joined       │ Agent được phân công → visitor thấy tên           │
 * │ agent:typing       │ Agent đang / ngừng gõ                             │
 * │ agent:reaction     │ Reaction update broadcast to widget               │
 * │ message:status     │ Status update (delivered/read) for visitor msgs   │
 * └────────────────────┴───────────────────────────────────────────────────┘
 */
@WebSocketGateway({
  namespace: '/livechat',
  // FIX: Restrict CORS to configured allowed origins (not wildcard in production).
  // LIVECHAT_CORS_ORIGINS env var: comma-separated list, e.g. "https://mysite.com,https://app.mysite.com"
  // Falls back to '*' only when not set (local dev convenience).
  cors: {
    origin: process.env.LIVECHAT_CORS_ORIGINS
      ? process.env.LIVECHAT_CORS_ORIGINS.split(',')
      : '*',
    credentials: false,
  },
  transports: ['websocket', 'polling'],
  // FIX: Hard-cap at 30 MB at the transport layer so oversized payloads are
  // rejected before they enter the event handler (prevents OOM on 20MB guard check).
  maxHttpBufferSize: 30 * 1024 * 1024,
})
export class LivechatGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(LivechatGateway.name);

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly channelRepo: ChannelRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly widgetService: LivechatWidgetService,
    private readonly messageStatusService: MessageStatusService,
    private readonly cls: ClsService,
    private readonly rateLimiter: SocketRateLimiter,
  ) {}

  // ── Lifecycle ───────────────────────────────────────────────────────────

  handleConnection(client: Socket) {
    this.logger.debug(`Visitor socket connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    const { visitorId, conversationId, tenantId } = client.data ?? {};
    if (!visitorId) return;

    // T-031: Clean up rate limit keys for disconnected socket
    this.rateLimiter.cleanup(client.id).catch(() => undefined);

    this.logger.debug(`Visitor ${visitorId} disconnected`);

    // Forward typing=false so agent UI clears the typing bubble
    if (conversationId && tenantId) {
      this.eventEmitter.emit(OmniEvents.VISITOR_TYPING_LIVECHAT, {
        conversationId,
        visitorId,
        tenantId,
        isTyping: false,
      });
    }
  }

  // ── Visitor → Server ────────────────────────────────────────────────────

  @SubscribeMessage('visitor:connect')
  async onVisitorConnect(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      visitorId: string;
      tenantId: string;
      channelId: string;
      widgetId?: string;
      pageUrl?: string;
      userHash?: string;
    },
  ) {
    const { visitorId, tenantId, channelId, widgetId } = data;
    if (!visitorId || !tenantId || !channelId) {
      client.emit('error', {
        message: 'Missing required fields: visitorId, tenantId, channelId',
      });
      return;
    }

    // T-036 Security: Validate tenantId by cross-referencing with channelId.
    const validationError = await this.validateChannelOwnership(
      channelId,
      tenantId,
      visitorId,
    );
    if (validationError) {
      client.emit('error', { message: validationError });
      client.disconnect(true);
      return;
    }

    // Domain whitelist enforcement and identity verification
    const isConnectionValid = await this.validateVisitorConnection(
      client,
      widgetId,
      visitorId,
      data.userHash,
    );
    if (!isConnectionValid) {
      client.disconnect(true);
      return;
    }

    // Store context in socket.data — no DB write needed
    client.data.visitorId = visitorId;
    client.data.tenantId = tenantId;
    client.data.channelId = channelId;
    if (widgetId) client.data.widgetId = widgetId;

    // Join visitor room — used for all server→visitor pushes
    await client.join(`visitor:${visitorId}`);
    // Join tenant monitoring room (agent can watch all livechat sessions)
    await client.join(`tenant:${tenantId}:livechat`);

    // Lookup any existing active conversation for this visitor.
    // Must run inside runWithTenantContext — WS handlers have no HTTP middleware
    // so CLS activeTenantId is never set automatically.
    let conversationId: string | null = null;
    try {
      const conv = await runWithTenantContext(this.cls, tenantId, () =>
        this.conversationRepo.findActiveByExternalId(
          tenantId,
          'livechat',
          channelId,
          visitorId,
        ),
      );
      conversationId = conv?.id ?? null;
      if (conversationId) {
        client.data.conversationId = conversationId;
      }
    } catch (err) {
      this.logger.warn(
        `Could not resolve conversation for visitor ${visitorId}: ${(err as Error)?.message}`,
      );
    }

    client.emit('visitor:connected', { visitorId, conversationId });
    this.logger.log(`Visitor ${visitorId} connected to tenant ${tenantId}`);
  }

  @SubscribeMessage('visitor:message')
  async onVisitorMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      visitorId?: string;
      tenantId?: string;
      channelId?: string;
      text: string;
      timestamp?: string;
      metadata?: Record<string, any>;
    },
  ) {
    // Prefer socket.data context (set at connect) over per-message fields
    const visitorId = data.visitorId ?? client.data.visitorId;
    const tenantId = data.tenantId ?? client.data.tenantId;
    const channelId = data.channelId ?? client.data.channelId;

    if (!visitorId || !tenantId || !data.text) return;

    // T-031: Rate limit visitor messages
    if (!(await this.checkRateLimit(client, 'visitor:message'))) return;

    this.eventEmitter.emit(LivechatEvents.MESSAGE_INBOUND, {
      visitorId,
      tenantId,
      channelId,
      widgetId: client.data.widgetId,
      text: data.text,
      timestamp: data.timestamp ?? new Date().toISOString(),
      visitorName: client.data.visitorName ?? 'Visitor',
      metadata: {
        ...(data.metadata ?? {}),
        // Pass all identity data from pre-chat form (dynamic fields)
        ...(client.data.identityData ?? {}),
      },
    });
  }

  /**
   * Visitor file upload via base64.
   * Size guard: reject files > 20 MB.
   */
  @SubscribeMessage('visitor:upload')
  async onVisitorUpload(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      fileName: string;
      mimeType: string;
      fileSize?: number;
      base64: string;
      timestamp?: string;
    },
  ) {
    const visitorId = client.data.visitorId;
    const tenantId = client.data.tenantId;
    const channelId = client.data.channelId;

    if (!visitorId || !tenantId || !data.base64 || !data.fileName) {
      client.emit('upload:error', {
        message: 'Missing required upload fields',
      });
      return;
    }

    const MAX_BASE64_LEN = 28_000_000; // ~20 MB raw
    if (data.base64.length > MAX_BASE64_LEN) {
      client.emit('upload:error', { message: 'File too large (max 20 MB)' });
      return;
    }

    // T-031: Rate limit file uploads
    if (!(await this.checkRateLimit(client, 'visitor:upload'))) return;

    this.logger.log(
      `Visitor ${visitorId} uploading "${data.fileName}" (${data.mimeType})`,
    );

    this.eventEmitter.emit(LivechatEvents.MEDIA_INBOUND, {
      visitorId,
      tenantId,
      channelId,
      widgetId: client.data.widgetId,
      fileName: data.fileName,
      mimeType: data.mimeType,
      fileSize: data.fileSize ?? 0,
      base64: data.base64,
      timestamp: data.timestamp ?? new Date().toISOString(),
      visitorName: client.data.visitorName ?? 'Visitor',
    });
  }

  /**
   * Visitor typing indicator — forwarded to agent CRM via EventEmitter.
   */
  @SubscribeMessage('visitor:typing')
  async onVisitorTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { isTyping: boolean; conversationId?: string },
  ) {
    const visitorId = client.data.visitorId;
    const tenantId = client.data.tenantId;
    const conversationId = data.conversationId ?? client.data.conversationId;

    if (!visitorId || !tenantId || !conversationId) return;

    // T-031: Rate limit typing events
    if (!(await this.checkRateLimit(client, 'visitor:typing'))) return;

    // Cache conversationId so disconnect can clear typing
    if (!client.data.conversationId) {
      client.data.conversationId = conversationId;
    }

    this.eventEmitter.emit(OmniEvents.VISITOR_TYPING_LIVECHAT, {
      conversationId,
      visitorId,
      tenantId,
      isTyping: data.isTyping,
    });
  }

  @SubscribeMessage('visitor:identify')
  async onVisitorIdentify(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: Record<string, any>,
  ) {
    const visitorId = client.data.visitorId;
    const tenantId = client.data.tenantId;
    if (!visitorId || !tenantId) return;

    // Store ALL identity data generically — field keys are dynamic
    // (admin-configured via widget preChatForm.fields).
    // Do NOT destructure specific field names here.
    client.data.identityData = data;

    // Best-effort display name: try common keys for conversation.customer
    const displayName = data.name ?? data.full_name ?? data.ho_ten;
    if (displayName) client.data.visitorName = displayName;

    const conversationId: string | undefined = client.data.conversationId;

    // Await enrichment so identity cache is populated BEFORE the widget
    // unlocks chat input. This prevents the race condition where the
    // visitor sends a message before enrichment finishes writing to Redis.
    // ContactEnrichmentService.enrichFromPreChat() handles updateCustomerInfo
    // internally when conversationId is present, so no need to call it here.
    await this.eventEmitter.emitAsync(LivechatEvents.VISITOR_IDENTIFIED, {
      tenantId,
      visitorId,
      channelId: client.data.channelId,
      widgetId: client.data.widgetId,
      conversationId,
      identityData: data,
    });

    client.emit('visitor:identified', { success: true });
  }

  // ── Server → Visitor ────────────────────────────────────────────────────

  /**
   * Send text or media from agent to visitor.
   * Routing via Socket.IO room — no socketId lookup needed.
   */
  sendToVisitor(
    visitorId: string,
    payload:
      | { type: 'text'; content: string; messageId?: string }
      | {
          type: 'image' | 'video' | 'audio' | 'file';
          url?: string;
          mimeType: string;
          fileName: string;
          fileSize?: number;
          thumbnailUrl?: string;
          messageId?: string;
        }
      | { type: 'carousel'; content?: string; cards: any[]; messageId?: string }
      | {
          type: 'interactive';
          content: string;
          buttons: any[];
          messageId?: string;
        },
  ): void {
    const room = `visitor:${visitorId}`;
    this.logger.debug(
      `[sendToVisitor] room="${room}" payload.type=${payload.type}`,
    );
    this.server.to(room).emit('agent:message', {
      ...payload,
      // Expose internal messageId so the widget can track serverMessageId
      // and send read receipts (visitor:read) back to the server.
      ...(payload.messageId
        ? { messageId: payload.messageId, id: payload.messageId }
        : {}),
    });
  }

  /** P2.4: emit agent:joined with both name and avatar URL */
  notifyAgentJoined(
    visitorId: string,
    agentName: string,
    agentAvatarUrl?: string | null,
  ): void {
    this.server.to(`visitor:${visitorId}`).emit('agent:joined', {
      agentName,
      agentAvatarUrl: agentAvatarUrl ?? null,
    });
  }

  sendTypingIndicator(visitorId: string, isTyping: boolean): void {
    const room = `visitor:${visitorId}`;
    this.logger.debug(
      `sendTypingIndicator: isTyping=${isTyping} → room=${room}`,
    );
    this.server.to(room).emit('agent:typing', { isTyping });
  }

  // ── Delivery / Read Receipts ─────────────────────────────────────────────

  /**
   * Visitor acknowledges receipt of agent messages (auto-ack on receive).
   * Advances status: sent → delivered.
   */
  @SubscribeMessage('visitor:ack')
  async handleVisitorAck(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { messageIds: string[] },
  ) {
    const tenantId = client.data?.tenantId;
    if (!tenantId || !data?.messageIds?.length) return;

    this.logger.debug(
      `Visitor ${client.data.visitorId} ack'd ${data.messageIds.length} message(s)`,
    );

    // Wrap with tenant context — WS handlers bypass HTTP middleware so CLS is empty.
    await runWithTenantContext(this.cls, tenantId, () =>
      this.messageStatusService.markDelivered(tenantId, data.messageIds),
    );
  }

  /**
   * Visitor has scrolled agent messages into viewport (read receipt).
   * Advances status: sent/delivered → read.
   */
  @SubscribeMessage('visitor:read')
  async handleVisitorRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { messageIds: string[] },
  ) {
    const tenantId = client.data?.tenantId;
    if (!tenantId || !data?.messageIds?.length) return;

    this.logger.debug(
      `Visitor ${client.data.visitorId} read ${data.messageIds.length} message(s)`,
    );

    // Wrap with tenant context — WS handlers bypass HTTP middleware so CLS is empty.
    await runWithTenantContext(this.cls, tenantId, () =>
      this.messageStatusService.markRead(tenantId, data.messageIds),
    );
  }

  /**
   * Push message status updates to the visitor widget.
   * Used when agent reads visitor messages → visitor sees blue ticks.
   *
   * The `markAll` flag tells the widget to mark ALL its visitor-sent messages
   * as `read`, since the widget does not know MongoDB IDs of its own messages.
   */
  sendStatusToVisitor(
    visitorId: string,
    payload: { messageIds: string[]; status: string; markAll?: boolean },
  ): void {
    this.server.to(`visitor:${visitorId}`).emit('message:status', payload);
  }

  // ── Visitor Reactions ────────────────────────────────────────────────────

  /**
   * Handle visitor emoji reaction from the widget.
   * Emits 'omni.reaction.inbound' into the unified reaction pipeline.
   */
  @SubscribeMessage('visitor:reaction')
  handleVisitorReaction(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { messageId: string; emoji: string; action?: string },
  ) {
    const visitorId = client.data?.visitorId;
    const tenantId = client.data?.tenantId;
    const channelId = client.data?.channelId;

    if (!visitorId || !tenantId || !data?.messageId || !data?.emoji) {
      return;
    }

    this.logger.debug(
      `Visitor ${visitorId} reacted ${data.emoji} on message ${data.messageId}`,
    );

    this.eventEmitter.emit(OmniEvents.REACTION_INBOUND, {
      tenantId,
      channelType: 'livechat',
      channelId: channelId ?? '',
      messageId: data.messageId,
      externalMessageId: data.messageId,
      senderId: visitorId,
      senderType: 'customer',
      emoji: data.emoji,
      action: data.action ?? 'react',
      timestamp: new Date(),
    });
  }

  /**
   * Broadcast a reaction update to a visitor's widget.
   * Called by OmniGateway when 'omni.reaction.persisted' is emitted.
   */
  sendReactionToVisitor(
    visitorId: string,
    payload: {
      messageId: string;
      reactions: Array<{ emoji: string; senderId: string; senderType: string }>;
    },
  ): void {
    this.server.to(`visitor:${visitorId}`).emit('agent:reaction', payload);
  }

  // ── File Upload Events ────────────────────────────────────────────────────

  @OnEvent(LivechatEvents.VISITOR_UPLOAD_COMPLETED)
  handleVisitorUploadCompleted(payload: {
    tenantId: string;
    visitorId: string;
    fileName: string;
    mimeType: string;
  }): void {
    this.server.to(`visitor:${payload.visitorId}`).emit('upload:ack', {
      fileName: payload.fileName,
      mimeType: payload.mimeType,
    });
  }

  @OnEvent(LivechatEvents.VISITOR_UPLOAD_FAILED)
  handleVisitorUploadFailed(payload: {
    tenantId: string;
    visitorId: string;
    fileName: string;
    error: string;
  }): void {
    this.server.to(`visitor:${payload.visitorId}`).emit('upload:error', {
      message: payload.error,
      fileName: payload.fileName,
    });
  }

  // ── T-031: Rate Limiting ────────────────────────────────────────────────

  /**
   * Check rate limit for a socket event. Returns false if rate limited.
   * Disconnects the socket after 3 consecutive violations.
   */
  private async checkRateLimit(
    client: Socket,
    eventName: string,
  ): Promise<boolean> {
    const allowed = await this.rateLimiter.isAllowed(client.id, eventName);
    if (!allowed) {
      const violations = await this.rateLimiter.trackViolation(client.id);
      client.emit('error', {
        message: 'Rate limited. Please slow down.',
        event: eventName,
      });

      if (violations >= 3) {
        this.logger.warn(
          `[RateLimit] Disconnecting abusive socket ${client.id} (visitor=${client.data?.visitorId}) after ${violations} violations`,
        );
        client.disconnect(true);
      }
      return false;
    }
    return true;
  }

  /**
   * Validate that the given channelId belongs to the claimed tenantId
   * and is a livechat channel. Returns an error message string on failure,
   * or null when the channel is valid.
   */
  private async validateChannelOwnership(
    channelId: string,
    tenantId: string,
    visitorId: string,
  ): Promise<string | null> {
    try {
      const channel = await this.channelRepo.findByIdNoTenant(channelId);
      if (!channel) {
        this.logger.warn(
          `[Security] Channel ${channelId} not found — rejecting visitor ${visitorId}`,
        );
        return 'Invalid channel';
      }
      if (channel.tenantId?.toString() !== tenantId) {
        this.logger.warn(
          `[Security] Tenant mismatch: visitor claimed tenant=${tenantId} but channel ${channelId} belongs to ${channel.tenantId}`,
        );
        return 'Invalid channel';
      }
      if (channel.type !== 'livechat') {
        this.logger.warn(
          `[Security] Channel ${channelId} is type="${channel.type}", not livechat`,
        );
        return 'Invalid channel';
      }
      return null;
    } catch (err) {
      this.logger.error(
        `[Security] Channel validation failed for ${channelId}: ${(err as Error)?.message}`,
      );
      return 'Channel validation failed';
    }
  }

  private async validateVisitorConnection(
    client: Socket,
    widgetId: string | undefined,
    visitorId: string,
    userHash: string | undefined,
  ): Promise<boolean> {
    if (!widgetId) return true;

    // Domain whitelist enforcement (check Origin header from handshake)
    const originHeader =
      client.handshake?.headers?.origin ?? client.handshake?.headers?.referer;
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    const allowed = await this.widgetService.isDomainAllowed(widgetId, origin);

    if (!allowed) {
      this.logger.warn(`Domain blocked for widget ${widgetId}: ${origin}`);
      client.emit('error', { message: 'Domain not allowed' });
      return false;
    }

    // HMAC identity verification (if widget requires it)
    if (userHash) {
      const result = await this.widgetService.verifyIdentity(
        widgetId,
        visitorId,
        userHash,
      );
      if (!result.valid) {
        this.logger.warn(
          `HMAC verification failed for visitor ${visitorId} on widget ${widgetId}`,
        );
        client.emit('error', { message: 'Identity verification failed' });
        return false;
      }
    }

    return true;
  }
}
