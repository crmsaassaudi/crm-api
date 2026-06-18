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
import { VisitorSessionService } from './visitor-session.service';

interface VisitorHandshake {
  visitorId: string;
  tenantId: string;
  channelId: string;
  pageUrl?: string;
}

interface VisitorMessage {
  visitorId: string;
  tenantId: string;
  text: string;
  timestamp?: string;
}

interface VisitorIdentify {
  visitorId: string;
  tenantId: string;
  email?: string;
  name?: string;
}

/**
 * LivechatGateway — Socket.IO namespace for livechat visitors.
 *
 * Namespace: /livechat  (public — no JWT required)
 *
 * Widget connects to: wss://api.crm.example.com/livechat
 *
 * Flow:
 *   1. Widget emits `visitor:connect` with visitorId (fingerprint) + tenantId
 *   2. Gateway upserts VisitorSession and joins visitor to room `visitor:{visitorId}`
 *   3. Widget emits `visitor:message` → Gateway emits OmniInbound webhook event
 *   4. Agent sends reply → Gateway emits `agent:message` to visitor room
 *
 * Rooms:
 *   - `visitor:{visitorId}` — visitor-specific room (one socket per tab)
 *   - `tenant:{tenantId}:livechat` — all livechat sessions for this tenant (agent monitoring)
 */
@WebSocketGateway({
  namespace: '/livechat',
  cors: { origin: '*', credentials: false }, // Widget is cross-origin
  transports: ['websocket', 'polling'],
})
export class LivechatGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(LivechatGateway.name);

  constructor(
    private readonly visitorSessionService: VisitorSessionService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Lifecycle ───────────────────────────────────────────────────────────

  handleConnection(client: Socket) {
    this.logger.debug(`Visitor connected: ${client.id}`);
  }

  async handleDisconnect(client: Socket) {
    // Mark session as disconnected (best-effort)
    const session = await this.visitorSessionService.getBySocketId(client.id);
    if (session) {
      this.logger.debug(`Visitor ${session.visitorId} disconnected`);
    }
  }

  // ── Visitor → Server ────────────────────────────────────────────────────

  @SubscribeMessage('visitor:connect')
  async onVisitorConnect(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: VisitorHandshake,
  ) {
    const { visitorId, tenantId, channelId, pageUrl } = data;
    if (!visitorId || !tenantId || !channelId) {
      client.emit('error', {
        message: 'Missing required fields: visitorId, tenantId, channelId',
      });
      return;
    }

    // Upsert session
    const session = await this.visitorSessionService.upsert({
      visitorId,
      tenantId,
      channelId,
      socketId: client.id,
      pageUrl,
      userAgent: client.handshake.headers['user-agent'],
    });

    // Join visitor room
    await client.join(`visitor:${visitorId}`);
    // Join tenant livechat room (for agent monitoring)
    await client.join(`tenant:${tenantId}:livechat`);

    client.emit('visitor:connected', {
      visitorId,
      conversationId: session.conversationId ?? null,
    });

    this.logger.log(`Visitor ${visitorId} joined tenant ${tenantId}`);
  }

  @SubscribeMessage('visitor:message')
  async onVisitorMessage(
    @ConnectedSocket() _client: Socket,
    @MessageBody() data: VisitorMessage,
  ) {
    const { visitorId, tenantId, text, timestamp } = data;
    if (!visitorId || !tenantId || !text) return;

    const session = await this.visitorSessionService.getByVisitor(
      visitorId,
      tenantId,
    );
    if (!session) return;

    // Emit into inbound pipeline via EventEmitter
    this.eventEmitter.emit('livechat.message.inbound', {
      visitorId,
      tenantId,
      channelId: session.channelId,
      text,
      timestamp: timestamp ?? new Date().toISOString(),
      visitorName: session.name ?? 'Visitor',
    });
  }

  @SubscribeMessage('visitor:identify')
  async onVisitorIdentify(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: VisitorIdentify,
  ) {
    const { visitorId, tenantId, email, name } = data;
    if (!visitorId || !tenantId) return;

    await this.visitorSessionService.enrich(visitorId, tenantId, {
      email,
      name,
    });
    client.emit('visitor:identified', { email, name });
  }

  // ── Server → Visitor ────────────────────────────────────────────────────

  /**
   * Send a message from the agent to the visitor.
   * Called by LivechatAdapter.send().
   */
  sendToVisitor(
    visitorId: string,
    payload:
      | { type: 'text'; content: string }
      | { type: 'media'; url: string; mimeType: string },
  ): Promise<void> {
    this.server.to(`visitor:${visitorId}`).emit('agent:message', payload);
  }

  /**
   * Notify the visitor that an agent joined the conversation.
   */
  notifyAgentJoined(visitorId: string, agentName: string): Promise<void> {
    this.server.to(`visitor:${visitorId}`).emit('agent:joined', { agentName });
  }

  /**
   * Send typing indicator to the visitor.
   */
  sendTypingIndicator(visitorId: string, isTyping: boolean): Promise<void> {
    this.server.to(`visitor:${visitorId}`).emit('agent:typing', { isTyping });
  }
}
