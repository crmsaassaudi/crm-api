import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OmniPayload } from '../domain/omni-payload';
import { AgentPresenceService } from './agent-presence.service';
import { AgentPresenceGateway } from './agent-presence.gateway';
import { OutboundService } from './outbound.service';
import { SessionService } from '../../auth/services/session.service';
import { TenantsService } from '../../tenants/tenants.service';
import { jwtDecode } from 'jwt-decode';
import * as cookie from 'cookie';

/**
 * Primary Socket.IO gateway for omni-channel real-time messaging.
 *
 * Event table:
 * ┌──────────────────────────────────┬────────────┬────────────────────────────────────┐
 * │ Event                            │ Direction  │ Purpose                            │
 * ├──────────────────────────────────┼────────────┼────────────────────────────────────┤
 * │ omni:message:send                │ C → S      │ Agent sends a reply                │
 * │ omni:message:new                 │ S → C      │ New inbound message (from webhook) │
 * │ omni:message:ack                 │ S → C      │ Server confirms message receipt    │
 * │ omni:typing:start / :stop        │ C ↔ S      │ Typing indicators                  │
 * │ omni:conversation:claim          │ C → S      │ Agent claims a conversation        │
 * │ omni:conversation:claimed        │ S → C      │ Broadcast who claimed              │
 * │ omni:collision                   │ S → C      │ Two agents claim the same conv.    │
 * └──────────────────────────────────┴────────────┴────────────────────────────────────┘
 */
@WebSocketGateway({ namespace: '/omni', cors: { origin: '*', credentials: true } })
export class OmniGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(OmniGateway.name);

  /** In-memory map: conversationId → userId who is currently claiming it */
  private claimLocks = new Map<string, { userId: string; at: Date }>();

  constructor(
    private readonly presenceService: AgentPresenceService,
    private readonly presenceGateway: AgentPresenceGateway,
    private readonly outboundService: OutboundService,
    private readonly sessionService: SessionService,
    private readonly tenantsService: TenantsService,
  ) {}

  private readonly ROOT_DOMAIN = 'crm.com';
  private readonly SYSTEM_SUBDOMAINS = ['api', 'admin', 'auth', 'www', 'mail'];

  // ─── Connection lifecycle ──────────────────────────────────────────

  async handleConnection(client: Socket) {
    try {
      // 1. Parse the sid cookie from the handshake headers
      const rawCookie = client.handshake.headers.cookie;
      const cookies = rawCookie ? cookie.parse(rawCookie) : {};
      const sid = cookies['sid'];

      if (!sid) {
        this.logger.warn(`Client ${client.id} has no session cookie (sid)`);
        client.disconnect();
        return;
      }

      // 2. Resolve session from Redis via SessionService
      const session = await this.sessionService.getSession(sid);
      if (!session) {
        this.logger.warn(`Client ${client.id} has invalid/expired session`);
        client.disconnect();
        return;
      }

      // 3. Decode the token to get user info
      const decoded: any = jwtDecode(session.idToken || session.accessToken);
      if (!decoded) {
        this.logger.warn(`Client ${client.id} has malformed token in session`);
        client.disconnect();
        return;
      }

      client.data.user = decoded;
      const userId = decoded.id ?? decoded.sub;

      // Resolve tenantId from the socket handshake hostname (subdomain → DB lookup)
      let tenantId = 'default-tenant';
      const host = client.handshake.headers.host ?? '';
      const hostWithoutPort = host.split(':')[0]; // Remove port
      if (hostWithoutPort.endsWith(`.${this.ROOT_DOMAIN}`)) {
        const subdomain = hostWithoutPort.slice(
          0,
          hostWithoutPort.length - this.ROOT_DOMAIN.length - 1,
        );
        if (
          subdomain &&
          !subdomain.includes('.') &&
          !this.SYSTEM_SUBDOMAINS.includes(subdomain.toLowerCase())
        ) {
          const tenant = await this.tenantsService.findByAlias(subdomain);
          if (tenant) {
            tenantId = tenant.id;
            this.logger.log(`Resolved tenant alias "${subdomain}" → ${tenantId}`);
          } else {
            this.logger.warn(`Tenant alias "${subdomain}" not found in DB`);
          }
        }
      }

      this.logger.debug(
        `JWT decoded for ${client.id}: tenantId=${tenantId}, userId=${userId}, ` +
        `host=${host}, fields=${Object.keys(decoded).join(',')}`,
      );

      // Join tenant room for broadcast events
      await client.join(`tenant:${tenantId}`);
      this.logger.log(`Agent ${userId} connected to /omni, joined room tenant:${tenantId}`);

      // Register agent presence
      await this.presenceGateway.onAgentConnected(tenantId, userId, client.id);
    } catch (error) {
      this.logger.error(`Connection error for client ${client.id}: ${error.message}`);
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    const user = client.data?.user;
    if (!user) return;

    const tenantId = user.tenantId ?? 'default-tenant';
    const userId = user.id ?? user.sub;

    await this.presenceGateway.onAgentDisconnected(tenantId, userId);
    this.logger.log(`Agent ${userId} disconnected from /omni`);
  }

  // ─── Messaging ─────────────────────────────────────────────────────

  @SubscribeMessage('omni:message:send')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      conversationId: string;
      content: string;
      messageType?: string;
      tempId?: string; // Client-side optimistic ID for matching acks
    },
  ) {
    const user = client.data.user;
    if (!user) return { ok: false, error: 'Unauthenticated' };

    const userId = user.id ?? user.sub;
    const tenantId = user.tenantId ?? 'default-tenant';

    this.logger.log(
      `Agent ${userId} sends message to conversation ${data.conversationId}`,
    );

    try {
      // Persist and send (outbound logic)
      const result = await this.outboundService.sendAgentMessage({
        tenantId,
        conversationId: data.conversationId,
        agentId: userId,
        content: data.content,
        messageType: data.messageType,
        source: 'socket',
      });

      const ack = {
        ok: true,
        tempId: data.tempId,
        messageId: result.messageId,
        timestamp: new Date().toISOString(),
        createdAt: new Date(),
      };

      // Broadcast the message to other agents watching this conversation
      client.to(`conversation:${data.conversationId}`).emit('omni:message:new', {
        conversationId: data.conversationId,
        senderId: userId,
        senderType: 'agent',
        messageType: data.messageType ?? 'text',
        content: data.content,
        messageId: ack.messageId,
        timestamp: ack.timestamp,
        createdAt: ack.createdAt,
      });

      return ack;
    } catch (error) {
      this.logger.error(`SendMessage error: ${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  /**
   * Listener for the `omni.message.persisted` domain event,
   * emitted by ConversationService AFTER the message is saved to DB.
   *
   * Broadcasts the enriched message (with internal conversationId) to agents via Socket.IO.
   */
  @OnEvent('omni.message.persisted')
  handleInboundMessage(payload: any) {
    const room = `tenant:${payload.tenantId}`;
    this.logger.log(
      `Broadcasting persisted ${payload.channelType} message to room=${room}, ` +
      `conversationId=${payload.conversationId}, senderId=${payload.senderId}`,
    );

    // Debug: check how many sockets are in this room
    const roomSockets = (this.server?.adapter as any)?.rooms?.get(room);
    this.logger.debug(
      `Room ${room} has ${roomSockets?.size ?? 0} socket(s)`,
    );

    this.server
      .to(room)
      .emit('omni:message:new', payload);
  }

  /**
   * Listener for `omni.conversation.created` domain event.
   * Broadcasts `omni:conversation:new` to the tenant room so the conversation
   * list sidebar updates in real-time when a brand new customer sends their first message.
   */
  @OnEvent('omni.conversation.created')
  handleConversationCreated(event: { tenantId: string; conversation: any }) {
    const room = `tenant:${event.tenantId}`;
    this.logger.log(`Broadcasting new conversation to room=${room}`);
    this.server.to(room).emit('omni:conversation:new', event.conversation);
  }

  /**
   * Listener for `omni.conversation.reopened` domain event.
   * Broadcasts `omni:conversation:reopened` to the tenant room so the conversation
   * that was previously resolved/closed re-appears at the top of the list.
   */
  @OnEvent('omni.conversation.reopened')
  handleConversationReopened(event: { tenantId: string; conversation: any }) {
    const room = `tenant:${event.tenantId}`;
    this.logger.log(`Broadcasting reopened conversation to room=${room}`);
    this.server.to(room).emit('omni:conversation:reopened', event.conversation);
  }

  /**
   * Listener for `omni.conversation.customer_updated` event.
   * Emitted after async Facebook profile enrichment completes.
   * Broadcasts the real customer name/avatar to the tenant room.
   */
  @OnEvent('omni.conversation.customer_updated')
  handleCustomerUpdated(event: { tenantId: string; conversationId: string; customer: any }) {
    const room = `tenant:${event.tenantId}`;
    this.logger.log(`Broadcasting customer profile update for conversation ${event.conversationId}`);
    this.server.to(room).emit('omni:conversation:customer_updated', {
      conversationId: event.conversationId,
      customer: event.customer,
    });
  }

  /**

   * Only broadcasts to the room if the message was sent via REST (HTTP).
   * If sent via socket, `handleSendMessage` already emits to clients.
   */
  @OnEvent('omni.message.sent')
  handleOutboundMessage(payload: any) {
    if (payload.source === 'http') {
      this.logger.log(`Broadcasting HTTP-sent message to conversation ${payload.conversationId}`);
      this.server
        .to(`conversation:${payload.conversationId}`)
        .emit('omni:message:new', {
          conversationId: payload.conversationId,
          senderId: payload.senderId,
          senderType: payload.senderType,
          messageType: payload.messageType,
          content: payload.content,
          messageId: payload.messageId,
          timestamp: payload.timestamp,
          createdAt: payload.createdAt || payload.timestamp || new Date(),
        });
    }
  }

  // ─── Typing indicators ─────────────────────────────────────────────

  @SubscribeMessage('omni:typing:start')
  handleTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const user = client.data.user;
    if (!user) return;

    client.to(`conversation:${data.conversationId}`).emit('omni:typing:start', {
      conversationId: data.conversationId,
      userId: user.id ?? user.sub,
      userName: user.name ?? 'Agent',
    });
  }

  @SubscribeMessage('omni:typing:stop')
  handleTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const user = client.data.user;
    if (!user) return;

    client.to(`conversation:${data.conversationId}`).emit('omni:typing:stop', {
      conversationId: data.conversationId,
      userId: user.id ?? user.sub,
    });
  }

  // ─── Collision detection ────────────────────────────────────────────

  @SubscribeMessage('omni:conversation:claim')
  async handleClaim(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const user = client.data.user;
    if (!user) return { ok: false, error: 'Unauthenticated' };

    const userId = user.id ?? user.sub;
    const tenantId = user.tenantId ?? 'default-tenant';
    const { conversationId } = data;

    // Check for existing claim
    const existingClaim = this.claimLocks.get(conversationId);
    if (existingClaim && existingClaim.userId !== userId) {
      // Collision! Another agent already claimed this conversation
      const timeSinceClaim =
        Date.now() - existingClaim.at.getTime();
      const STALE_CLAIM_MS = 5 * 60 * 1000; // 5 minutes

      if (timeSinceClaim < STALE_CLAIM_MS) {
        // Active claim exists → notify the new agent about collision
        client.emit('omni:collision', {
          conversationId,
          claimedBy: existingClaim.userId,
          claimedAt: existingClaim.at.toISOString(),
          message: 'This conversation is already claimed by another agent.',
        });

        this.logger.warn(
          `Collision: Agent ${userId} tried to claim conversation ` +
            `${conversationId} already claimed by ${existingClaim.userId}`,
        );

        return { ok: false, error: 'Already claimed', claimedBy: existingClaim.userId };
      }
      // Stale claim → allow override
    }

    // Set the claim
    this.claimLocks.set(conversationId, { userId, at: new Date() });

    // Try to assign the conversation capacity to this agent
    const assigned = await this.presenceService.assignConversation(
      tenantId,
      userId,
    );

    if (!assigned) {
      this.claimLocks.delete(conversationId);
      return { ok: false, error: 'Agent at capacity' };
    }

    // Join the conversation room for targeted events
    await client.join(`conversation:${conversationId}`);

    // Broadcast to the whole tenant that this conversation is claimed
    this.server.to(`tenant:${tenantId}`).emit('omni:conversation:claimed', {
      conversationId,
      claimedBy: userId,
      claimedAt: new Date().toISOString(),
    });

    this.logger.log(`Agent ${userId} claimed conversation ${conversationId}`);
    return { ok: true };
  }

  // ─── Event listeners: status & assignment broadcasts ────────────

  /**
   * Broadcast status changes (resolve, close, reopen) to all agents.
   */
  @OnEvent('omni.conversation.status_changed')
  handleStatusChanged(event: {
    tenantId: string;
    conversationId: string;
    status: string;
    oldStatus: string;
    agentId: string;
    reason?: string;
  }) {
    this.logger.log(
      `Broadcasting status change: ${event.conversationId} → ${event.status}`,
    );

    this.server
      .to(`tenant:${event.tenantId}`)
      .emit('omni:conversation:status_changed', {
        conversationId: event.conversationId,
        status: event.status,
        oldStatus: event.oldStatus,
        changedBy: event.agentId,
        reason: event.reason,
        timestamp: new Date().toISOString(),
      });
  }

  /**
   * Broadcast agent assignment changes to all agents.
   */
  @OnEvent('omni.conversation.assigned')
  handleAssignmentChanged(event: {
    tenantId: string;
    conversationId: string;
    agentId: string | null;
    oldAgentId: string | null;
  }) {
    this.logger.log(
      `Broadcasting assignment: ${event.conversationId} → ${event.agentId ?? 'unassigned'}`,
    );

    this.server
      .to(`tenant:${event.tenantId}`)
      .emit('omni:conversation:assigned', {
        conversationId: event.conversationId,
        agentId: event.agentId,
        oldAgentId: event.oldAgentId,
        timestamp: new Date().toISOString(),
      });
  }

  /**
   * Broadcast new note creation to agents watching the conversation.
   */
  @OnEvent('omni.conversation.note_added')
  handleNoteAdded(event: {
    tenantId: string;
    conversationId: string;
    noteId: string;
    authorId: string;
    isPrivate: boolean;
    content: string;
  }) {
    this.server
      .to(`tenant:${event.tenantId}`)
      .emit('omni:conversation:note_added', {
        conversationId: event.conversationId,
        noteId: event.noteId,
        authorId: event.authorId,
        isPrivate: event.isPrivate,
        content: event.content,
        timestamp: new Date().toISOString(),
      });
  }
}
