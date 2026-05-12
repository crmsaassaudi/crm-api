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
import { AgentPresenceService } from './agent-presence.service';
import { AgentPresenceGateway } from './agent-presence.gateway';
import { AgentFallbackService } from './agent-fallback.service';
import { OutboundService } from '../../omni-outbound/outbound.service';
import { SessionService } from '../../auth/services/session.service';
import { TenantsService } from '../../tenants/tenants.service';
import { UsersService } from '../../users/users.service';
import { jwtDecode } from 'jwt-decode';
import * as cookie from 'cookie';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '../../config/config.type';
import { ConversationLockService } from './conversation-lock.service';
import { v4 as uuidv4 } from 'uuid';

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
@WebSocketGateway({
  namespace: '/omni',
  cors: { origin: '*', credentials: true },
})
export class OmniGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(OmniGateway.name);

  /** In-memory map: conversationId → userId who is currently claiming it */
  private claimLocks = new Map<string, { userId: string; at: Date }>();

  constructor(
    private readonly presenceService: AgentPresenceService,
    private readonly presenceGateway: AgentPresenceGateway,
    private readonly outboundService: OutboundService,
    private readonly sessionService: SessionService,
    private readonly tenantsService: TenantsService,
    private readonly agentFallbackService: AgentFallbackService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService<AllConfigType>,
    private readonly conversationLockService: ConversationLockService,
  ) {}

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
      const keycloakUserId = decoded.id ?? decoded.sub;

      // ── Resolve MongoDB _id from keycloakId ──────────────────────────
      // The JWT contains the keycloakId (UUID), but channel configs, assignment,
      // and supportUserIds all use MongoDB ObjectId. We MUST resolve the internal
      // _id so presence, assignment, and pool filtering all use the same ID format.
      let userId = keycloakUserId;
      let dbUser: any = null;
      try {
        dbUser = await this.usersService.findByKeycloakIdAndProvider({
          keycloakId: keycloakUserId,
          provider: 'email',
        });
        if (dbUser) {
          userId = dbUser.id.toString();
          this.logger.log(
            `Resolved keycloakId ${keycloakUserId} → MongoDB _id ${userId}`,
          );
        } else {
          this.logger.warn(
            `Could not resolve MongoDB _id for keycloakId ${keycloakUserId} — using keycloakId as fallback`,
          );
        }
      } catch (err: any) {
        this.logger.warn(
          `Failed to resolve MongoDB _id for keycloakId ${keycloakUserId}: ${err.message} — using keycloakId as fallback`,
        );
      }

      // ── Resolve tenantId ────────────────────────────────────────────
      // Strategy: subdomain → user DB membership. No silent fallback.
      let tenantId: string | null = null;
      const host = client.handshake.headers.host ?? '';
      const hostWithoutPort = host.split(':')[0];

      const rootDomain =
        this.configService.get('app.rootDomain', { infer: true }) ??
        'crmsaudi.dev';

      // 1. Try subdomain resolution (production: tenant.crmsaudi.dev)
      if (hostWithoutPort.endsWith(`.${rootDomain}`)) {
        const subdomain = hostWithoutPort.slice(
          0,
          hostWithoutPort.length - rootDomain.length - 1,
        );
        if (
          subdomain &&
          !subdomain.includes('.') &&
          !this.SYSTEM_SUBDOMAINS.includes(subdomain.toLowerCase())
        ) {
          const tenant = await this.tenantsService.findByAlias(subdomain);
          if (tenant) {
            tenantId = tenant.id;
            this.logger.log(
              `Resolved tenant alias "${subdomain}" → ${tenantId}`,
            );
          } else {
            this.logger.warn(`Tenant alias "${subdomain}" not found in DB`);
          }
        }
      }

      // 2. Fallback: resolve from user's DB tenant membership (e.g. localhost)
      if (!tenantId && dbUser?.tenants?.length > 0) {
        tenantId = dbUser.tenants[0].tenantId?.toString() ?? null;
        if (tenantId) {
          this.logger.log(
            `No subdomain (host=${host}) — resolved tenantId from user membership: ${tenantId}`,
          );
        }
      }

      // 3. No tenant resolved → reject connection
      if (!tenantId) {
        this.logger.warn(
          `Client ${client.id} — cannot resolve tenantId (host=${host}, user=${userId}). Disconnecting.`,
        );
        client.disconnect();
        return;
      }

      this.logger.debug(
        `JWT decoded for ${client.id}: tenantId=${tenantId}, keycloakId=${keycloakUserId}, ` +
          `resolvedUserId=${userId}, host=${host}, fields=${Object.keys(decoded).join(',')}`,
      );

      // Persist resolved identifiers on the socket for use during disconnect
      client.data.tenantId = tenantId;
      client.data.userId = userId;

      // Join tenant room for broadcast events
      await client.join(`tenant:${tenantId}`);
      await client.join(`agent:${userId}`);
      this.logger.log(
        `Agent ${userId} connected to /omni, joined tenant:${tenantId} and agent:${userId}`,
      );

      // Register agent presence (multi-tab aware)
      await this.presenceGateway.onAgentConnected(tenantId, userId, client.id);

      // Cancel any pending reassignment from a previous disconnect
      await this.agentFallbackService.onAgentReconnected(tenantId, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Connection error for client ${client.id}: ${message}`);
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    const user = client.data?.user;
    if (!user) return;

    // Use the identifiers persisted during handleConnection
    const tenantId = client.data.tenantId;
    const userId = client.data.userId;
    if (!tenantId || !userId) return;

    // Per-socket disconnect (multi-tab aware).
    // Only triggers grace period when ALL sockets for this agent are gone.
    const { allDisconnected } = await this.presenceGateway.onAgentDisconnected(
      tenantId,
      userId,
      client.id,
    );

    // Only schedule fallback reassignment if ALL connections are lost.
    // The grace period in the gateway will delay the actual offline transition.
    if (allDisconnected) {
      await this.agentFallbackService.onAgentDisconnected(tenantId, userId);
    }

    this.logger.log(
      `Agent ${userId} socket ${client.id} disconnected from /omni` +
        (allDisconnected ? ' (all connections lost)' : ''),
    );
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
      idempotencyKey?: string;
      clientMessageId?: string;
    },
  ) {
    const user = client.data.user;
    if (!user) return { ok: false, error: 'Unauthenticated' };

    const userId = client.data.userId ?? user.id ?? user.sub;
    const tenantId = client.data.tenantId;
    if (!tenantId) return { ok: false, error: 'No tenant context' };

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
        idempotencyKey: data.idempotencyKey,
        clientMessageId: data.clientMessageId ?? data.tempId,
        source: 'socket',
      });

      const ack = {
        ok: true,
        tempId: data.tempId,
        messageId: result.messageId,
        idempotencyKey: result.idempotencyKey ?? data.idempotencyKey,
        clientMessageId:
          result.clientMessageId ?? data.clientMessageId ?? data.tempId,
        reused: result.reused ?? false,
        timestamp: new Date().toISOString(),
        createdAt: new Date(),
      };

      if (!result.reused) {
        // Broadcast the message to other agents watching this conversation
        client
          .to(`conversation:${data.conversationId}`)
          .emit('omni:message:new', {
            conversationId: data.conversationId,
            senderId: userId,
            senderType: 'agent',
            messageType: data.messageType ?? 'text',
            content: data.content,
            messageId: ack.messageId,
            idempotencyKey: ack.idempotencyKey,
            clientMessageId: ack.clientMessageId,
            timestamp: ack.timestamp,
            providerTimestamp: ack.timestamp,
            createdAt: ack.createdAt,
          });
      }

      return ack;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`SendMessage error: ${errorMessage}`);
      return { ok: false, error: errorMessage };
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
    this.logger.debug(`Room ${room} has ${roomSockets?.size ?? 0} socket(s)`);

    this.server.to(room).emit('omni:message:new', payload);
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
  handleCustomerUpdated(event: {
    tenantId: string;
    conversationId: string;
    customer: any;
  }) {
    const room = `tenant:${event.tenantId}`;
    this.logger.log(
      `Broadcasting customer profile update for conversation ${event.conversationId}`,
    );
    this.server.to(room).emit('omni:conversation:customer_updated', {
      conversationId: event.conversationId,
      customer: event.customer,
    });
  }

  /**
   * Listener for `omni.message.media_cached` domain event.
   * Emitted by MediaCacheProcessor after background media download completes.
   * Broadcasts the stable proxy URL so the frontend can swap the expiring
   * provider URL with the permanent cached version.
   */
  @OnEvent('omni.message.media_cached')
  handleMediaCached(event: {
    tenantId: string;
    conversationId: string;
    messageId: string;
    mediaProxyUrl: string;
  }) {
    const room = `tenant:${event.tenantId}`;
    this.logger.log(`Broadcasting media cached for message ${event.messageId}`);
    this.server.to(room).emit('omni:message:media_cached', {
      conversationId: event.conversationId,
      messageId: event.messageId,
      mediaProxyUrl: event.mediaProxyUrl,
    });
  }

  /**

   * Only broadcasts to the room if the message was sent via REST (HTTP).
   * If sent via socket, `handleSendMessage` already emits to clients.
   */
  @OnEvent('omni.message.sent')
  handleOutboundMessage(payload: any) {
    if (payload.source === 'http') {
      this.logger.log(
        `Broadcasting HTTP-sent message to conversation ${payload.conversationId}`,
      );
      this.server
        .to(`conversation:${payload.conversationId}`)
        .emit('omni:message:new', {
          conversationId: payload.conversationId,
          senderId: payload.senderId,
          senderType: payload.senderType,
          messageType: payload.messageType,
          content: payload.content,
          messageId: payload.messageId,
          idempotencyKey: payload.idempotencyKey,
          clientMessageId: payload.clientMessageId,
          timestamp: payload.timestamp,
          providerTimestamp: payload.timestamp,
          createdAt: payload.createdAt || payload.timestamp || new Date(),
        });
    }
  }

  @SubscribeMessage('conversation.subscribe')
  async handleConversationSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    if (!client.data.user) return { ok: false, error: 'Unauthenticated' };
    if (!data?.conversationId) {
      return { ok: false, error: 'conversationId is required' };
    }

    await client.join(`conversation:${data.conversationId}`);
    return { ok: true, room: `conversation:${data.conversationId}` };
  }

  @SubscribeMessage('conversation.unsubscribe')
  async handleConversationUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    if (!client.data.user) return { ok: false, error: 'Unauthenticated' };
    if (!data?.conversationId) {
      return { ok: false, error: 'conversationId is required' };
    }

    await client.leave(`conversation:${data.conversationId}`);
    return { ok: true, room: `conversation:${data.conversationId}` };
  }

  // ─── Typing indicators ─────────────────────────────────────────────

  @SubscribeMessage('omni:typing:start')
  async handleTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const user = client.data.user;
    if (!user) return;

    const userId = client.data.userId ?? user.id ?? user.sub;
    const tenantId = client.data.tenantId;
    if (tenantId && data?.conversationId) {
      try {
        await this.conversationLockService.heartbeat({
          tenantId,
          conversationId: data.conversationId,
          agentId: userId,
          agentName: user.name ?? null,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : error && typeof error === 'object' && 'message' in error
              ? (error as any).message
              : String(error);

        client.emit('omni:collision', {
          conversationId: data.conversationId,
          message,
          lock: (error as any)?.response?.lock,
        });
        return;
      }
    }

    client.to(`conversation:${data.conversationId}`).emit('omni:typing:start', {
      conversationId: data.conversationId,
      userId,
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
      userId: client.data.userId ?? user.id ?? user.sub,
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

    const userId = client.data.userId ?? user.id ?? user.sub;
    const tenantId = client.data.tenantId;
    if (!tenantId) return { ok: false, error: 'No tenant context' };
    const { conversationId } = data;

    // Check for existing claim
    const existingClaim = this.claimLocks.get(conversationId);
    if (existingClaim && existingClaim.userId !== userId) {
      // Collision! Another agent already claimed this conversation
      const timeSinceClaim = Date.now() - existingClaim.at.getTime();
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

        return {
          ok: false,
          error: 'Already claimed',
          claimedBy: existingClaim.userId,
        };
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

    try {
      await this.conversationLockService.acquireLock({
        tenantId,
        conversationId,
        agentId: userId,
        agentName: user.name ?? null,
        source: 'conversation_claim',
      });
    } catch (error: unknown) {
      const lock =
        typeof error === 'object' &&
        error !== null &&
        'response' in error &&
        typeof (error as { response?: unknown }).response === 'object' &&
        (error as { response?: unknown }).response !== null &&
        'lock' in ((error as { response?: { lock?: unknown } }).response ?? {})
          ? (error as { response?: { lock?: unknown } }).response?.lock
          : undefined;

      this.claimLocks.delete(conversationId);
      await this.presenceService.releaseConversation(tenantId, userId);
      client.emit('omni:collision', {
        conversationId,
        message: 'This conversation is already claimed by another agent.',
        lock,
      });
      return {
        ok: false,
        error: 'Already claimed',
        lock,
      };
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

  @SubscribeMessage('conversation.lock.heartbeat')
  async handleLockHeartbeat(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const user = client.data.user;
    if (!user) return { ok: false, error: 'Unauthenticated' };
    const tenantId = client.data.tenantId;
    const agentId = client.data.userId ?? user.id ?? user.sub;
    if (!tenantId) return { ok: false, error: 'No tenant context' };

    try {
      const lock = await this.conversationLockService.heartbeat({
        tenantId,
        conversationId: data.conversationId,
        agentId,
        agentName: user.name ?? null,
      });
      return { ok: true, lock };
    } catch (error: any) {
      return { ok: false, error: error.message, lock: error.response?.lock };
    }
  }

  @SubscribeMessage('conversation.takeover')
  async handleConversationTakeover(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { conversationId: string; reason?: string; force?: boolean },
  ) {
    const user = client.data.user;
    if (!user) return { ok: false, error: 'Unauthenticated' };
    const tenantId = client.data.tenantId;
    const agentId = client.data.userId ?? user.id ?? user.sub;
    if (!tenantId) return { ok: false, error: 'No tenant context' };

    try {
      const result = await this.conversationLockService.takeover({
        tenantId,
        conversationId: data.conversationId,
        newAgentId: agentId,
        newAgentName: user.name ?? null,
        reason: data.reason,
        force: data.force ?? false,
      });
      return {
        ok: true,
        previousAgentId: result.previousLock?.agentId ?? null,
        newAgentId: agentId,
        lockExpiresAt: result.newLock.expiresAt,
      };
    } catch (error: any) {
      return { ok: false, error: error.message, lock: error.response?.lock };
    }
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
    groupId?: string | null;
  }) {
    this.logger.log(
      `Broadcasting assignment: ${event.conversationId} → agent=${event.agentId ?? 'unassigned'}, group=${event.groupId ?? 'unchanged'}`,
    );

    this.server
      .to(`tenant:${event.tenantId}`)
      .emit('omni:conversation:assigned', {
        conversationId: event.conversationId,
        agentId: event.agentId,
        oldAgentId: event.oldAgentId,
        groupId: event.groupId,
        timestamp: new Date().toISOString(),
      });
  }

  @OnEvent('omni.conversation.lock_acquired')
  handleLockAcquired(event: any) {
    const payload = this.standardEvent('conversation.lock_acquired', event);
    this.server
      .to(`conversation:${event.conversationId}`)
      .emit('conversation.lock_acquired', payload);
    this.server
      .to(`tenant:${event.tenantId}`)
      .emit('omni:conversation:locked', {
        conversationId: event.conversationId,
        lockedBy: event.agentId,
        lockedByName: event.agentName,
        expiresAt: event.expiresAt,
      });
  }

  @OnEvent('omni.conversation.lock_released')
  handleLockReleased(event: any) {
    const payload = this.standardEvent('conversation.lock_released', event);
    this.server
      .to(`conversation:${event.conversationId}`)
      .emit('conversation.lock_released', payload);
    this.server
      .to(`tenant:${event.tenantId}`)
      .emit('omni:conversation:unlocked', {
        conversationId: event.conversationId,
        agentId: event.agentId,
        releasedAt: event.releasedAt,
      });
  }

  @OnEvent('omni.conversation.takeover')
  handleTakeover(event: any) {
    const payload = this.standardEvent('conversation.takeover', event);
    this.server
      .to(`conversation:${event.conversationId}`)
      .emit('conversation.takeover', payload);

    if (event.previousAgentId) {
      this.server
        .to(`agent:${event.previousAgentId}`)
        .emit('conversation.takeover', payload);
    }
    this.server
      .to(`agent:${event.newAgentId}`)
      .emit('conversation.takeover', payload);

    this.server
      .to(`tenant:${event.tenantId}`)
      .emit('omni:conversation:takeover', {
        conversationId: event.conversationId,
        previousAgentId: event.previousAgentId,
        newAgentId: event.newAgentId,
        newAgentName: event.newAgentName,
        reason: event.reason,
        occurredAt: event.occurredAt,
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
    authorName?: string;
    isPrivate: boolean;
    content: string;
  }) {
    this.server
      .to(`tenant:${event.tenantId}`)
      .emit('omni:conversation:note_added', {
        conversationId: event.conversationId,
        noteId: event.noteId,
        authorId: event.authorId,
        authorName: event.authorName,
        isPrivate: event.isPrivate,
        content: event.content,
        timestamp: new Date().toISOString(),
      });
  }

  // ─── Activity (Audit Trail) real-time broadcast ─────────────────

  /**
   * Broadcast new activity log entries to the tenant room.
   * This enables inline system messages in the ChatWindow
   * (e.g. "Hệ thống đã gán cuộc hội thoại cho Nguyễn Văn A").
   */
  @OnEvent('omni.activity.created')
  handleActivityCreated(event: {
    tenantId: string;
    conversationId: string;
    activity: any;
  }) {
    if (!event.tenantId) return;
    const room = `tenant:${event.tenantId}`;
    this.logger.debug(
      `Broadcasting activity "${event.activity?.action}" for conversation ${event.conversationId}`,
    );
    this.server.to(room).emit('omni:activity:new', {
      conversationId: event.conversationId,
      activity: event.activity,
    });
  }

  private standardEvent(eventName: string, payload: any) {
    return {
      eventId: uuidv4(),
      event: eventName,
      conversationId: payload.conversationId,
      occurredAt: payload.occurredAt ?? new Date().toISOString(),
      version: Date.now(),
      payload,
    };
  }
}
