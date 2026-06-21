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
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ConversationRepository } from '../omni-inbound/repositories/conversation.repository';
import { LivechatWidgetService } from './livechat-widget.service';
import { MessageStatusService } from './services/message-status.service';
import { runWithTenantContext } from '../common/tenancy/tenant-context';

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
    private readonly eventEmitter: EventEmitter2,
    private readonly widgetService: LivechatWidgetService,
    private readonly messageStatusService: MessageStatusService,
    private readonly cls: ClsService,
  ) {}

  // ── Lifecycle ───────────────────────────────────────────────────────────

  handleConnection(client: Socket) {
    this.logger.debug(`Visitor socket connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    const { visitorId, conversationId, tenantId } = client.data ?? {};
    if (!visitorId) return;

    this.logger.debug(`Visitor ${visitorId} disconnected`);

    // Forward typing=false so agent UI clears the typing bubble
    if (conversationId && tenantId) {
      this.eventEmitter.emit('omni.visitor.typing.livechat', {
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

    // Domain whitelist enforcement (check Origin header from handshake)
    if (widgetId) {
      const origin =
        client.handshake?.headers?.origin || client.handshake?.headers?.referer;
      const allowed = await this.widgetService.isDomainAllowed(
        widgetId,
        origin as string | undefined,
      );
      if (!allowed) {
        this.logger.warn(`Domain blocked for widget ${widgetId}: ${origin}`);
        client.emit('error', { message: 'Domain not allowed' });
        client.disconnect(true);
        return;
      }
    }

    // HMAC identity verification (if widget requires it)
    if (widgetId && data.userHash) {
      const result = await this.widgetService.verifyIdentity(
        widgetId,
        visitorId,
        data.userHash,
      );
      if (!result.valid) {
        this.logger.warn(
          `HMAC verification failed for visitor ${visitorId} on widget ${widgetId}`,
        );
        client.emit('error', { message: 'Identity verification failed' });
        client.disconnect(true);
        return;
      }
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
    } catch (err: any) {
      this.logger.warn(
        `Could not resolve conversation for visitor ${visitorId}: ${err?.message}`,
      );
    }

    client.emit('visitor:connected', { visitorId, conversationId });
    this.logger.log(`Visitor ${visitorId} connected to tenant ${tenantId}`);
  }

  @SubscribeMessage('visitor:message')
  onVisitorMessage(
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

    this.eventEmitter.emit('livechat.message.inbound', {
      visitorId,
      tenantId,
      channelId,
      text: data.text,
      timestamp: data.timestamp ?? new Date().toISOString(),
      visitorName: 'Visitor',
      metadata: data.metadata,
    });
  }

  /**
   * Visitor file upload via base64.
   * Size guard: reject files > 20 MB.
   */
  @SubscribeMessage('visitor:upload')
  onVisitorUpload(
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

    this.logger.log(
      `Visitor ${visitorId} uploading "${data.fileName}" (${data.mimeType})`,
    );

    this.eventEmitter.emit('livechat.media.inbound', {
      visitorId,
      tenantId,
      channelId,
      fileName: data.fileName,
      mimeType: data.mimeType,
      fileSize: data.fileSize ?? 0,
      base64: data.base64,
      timestamp: data.timestamp ?? new Date().toISOString(),
      visitorName: 'Visitor',
    });

    client.emit('upload:ack', {
      fileName: data.fileName,
      mimeType: data.mimeType,
    });
  }

  /**
   * Visitor typing indicator — forwarded to agent CRM via EventEmitter.
   */
  @SubscribeMessage('visitor:typing')
  onVisitorTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { isTyping: boolean; conversationId?: string },
  ) {
    const visitorId = client.data.visitorId;
    const tenantId = client.data.tenantId;
    const conversationId = data.conversationId ?? client.data.conversationId;

    if (!visitorId || !tenantId || !conversationId) return;

    // Cache conversationId so disconnect can clear typing
    if (!client.data.conversationId) {
      client.data.conversationId = conversationId;
    }

    this.eventEmitter.emit('omni.visitor.typing.livechat', {
      conversationId,
      visitorId,
      tenantId,
      isTyping: data.isTyping,
    });
  }

  @SubscribeMessage('visitor:identify')
  async onVisitorIdentify(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { email?: string; name?: string; phone?: string },
  ) {
    const visitorId = client.data.visitorId;
    const tenantId = client.data.tenantId;
    if (!visitorId || !tenantId) return;

    // FIX: Use cached conversationId from socket.data instead of a redundant
    // DB query. visitor:connect already resolved it on handshake.
    const conversationId: string | undefined = client.data.conversationId;

    if (conversationId) {
      try {
        await this.conversationRepo.updateCustomerInfo(conversationId, {
          email: data.email,
          name: data.name,
          // phone stored via generic customer update — updateCustomerInfo accepts extra fields
          ...(data.phone ? { phone: data.phone } : {}),
        });
      } catch (err: any) {
        this.logger.warn(
          `identify update failed for ${visitorId}: ${err?.message}`,
        );
      }
    } else {
      // No active conversation yet (visitor identified before first message).
      // Store on socket.data so handleTextInbound can include it in visitorName.
      if (data.name) client.data.visitorName = data.name;
      if (data.email) client.data.visitorEmail = data.email;
      if (data.phone) client.data.visitorPhone = data.phone;
    }

    client.emit('visitor:identified', {
      email: data.email,
      name: data.name,
      phone: data.phone,
    });
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
          type: 'media';
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
    const sockets = this.server.in(room).fetchSockets();
    sockets
      .then((s) => {
        this.logger.log(
          `[sendToVisitor] room="${room}" → ${s.length} socket(s) connected. Payload type=${payload.type}`,
        );
      })
      .catch(() => {});
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

    this.eventEmitter.emit('omni.reaction.inbound', {
      tenantId,
      channelType: 'livechat',
      channelId: channelId ?? '',
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
}
