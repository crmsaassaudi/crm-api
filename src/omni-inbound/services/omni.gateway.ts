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
import { Inject, Logger, OnModuleInit } from '@nestjs/common';
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
import { ulid } from 'ulid';
import Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { isDedicatedWorkerProcess } from '../../config/runtime-role';

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
  // MED-08b: Replace origin: '*' with an env-driven allowlist.
  // origin: '*' + credentials: true allows any site to open a socket with
  // the user's cookies, enabling session hijacking and cross-site data exfil.
  cors: {
    origin: process.env.FRONTEND_DOMAIN
      ? process.env.FRONTEND_DOMAIN.split(',').map((s) => s.trim())
      : ['http://localhost:3000'],
    credentials: true,
  },
})
export class OmniGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(OmniGateway.name);
  private readonly socketEventChannels = [
    'socket:contact:export:completed',
    'socket:account:export:completed',
    'socket:deal:export:completed',
    'socket:ticket:export:completed',
    'socket:contact:import:completed',
    'socket:account:import:completed',
    'socket:deal:import:completed',
    'socket:ticket:import:completed',
    'socket:omni:message:persisted',
    'socket:omni:conversation:created',
    'socket:omni:conversation:reopened',
    'socket:omni:conversation:customer_updated',
    'socket:omni:message:media_cached',
  ] as const;

  // HIGH-06: Claim lock TTL in seconds. Redis-backed claim locks auto-expire
  // so stale claims from crashed pods are cleaned up automatically.
  private static readonly CLAIM_LOCK_TTL_SECONDS = 300; // 5 minutes

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
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Subscribe to Redis pub/sub channels for cross-process events.
   * Worker processes publish events via Redis; the API process
   * receives them here and broadcasts via Socket.IO.
   */
  onModuleInit() {
    if (isDedicatedWorkerProcess()) return; // Only API/all-in-one process needs to subscribe

    const sub = this.redis.duplicate();
    void sub.subscribe(...this.socketEventChannels, (err) => {
      if (err) {
        this.logger.error('Failed to subscribe to Redis socket channels', err);
      } else {
        this.logger.log(
          `Subscribed to Redis socket channels: ${this.socketEventChannels.join(', ')}`,
        );
      }
    });

    sub.on('message', (channel: string, message: string) => {
      try {
        const event = JSON.parse(message);
        switch (channel) {
          case 'socket:contact:export:completed':
            this.handleContactExportCompleted(event);
            break;
          case 'socket:account:export:completed':
            this.handleModuleExportCompleted('account', event);
            break;
          case 'socket:deal:export:completed':
            this.handleModuleExportCompleted('deal', event);
            break;
          case 'socket:ticket:export:completed':
            this.handleModuleExportCompleted('ticket', event);
            break;
          case 'socket:contact:import:completed':
            this.handleContactImportCompleted(event);
            break;
          case 'socket:account:import:completed':
            this.handleModuleImportCompleted('account', event);
            break;
          case 'socket:deal:import:completed':
            this.handleModuleImportCompleted('deal', event);
            break;
          case 'socket:ticket:import:completed':
            this.handleModuleImportCompleted('ticket', event);
            break;
          case 'socket:omni:message:persisted':
            this.broadcastInboundMessage(event);
            break;
          case 'socket:omni:conversation:created':
            this.broadcastConversationCreated(event);
            break;
          case 'socket:omni:conversation:reopened':
            this.broadcastConversationReopened(event);
            break;
          case 'socket:omni:conversation:customer_updated':
            this.broadcastCustomerUpdated(event);
            break;
          case 'socket:omni:message:media_cached':
            this.broadcastMediaCached(event);
            break;
        }
      } catch (err) {
        this.logger.error(
          `Failed to handle Redis socket event ${channel}`,
          err,
        );
      }
    });
  }

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
      // Strategy: subdomain or explicit token/handshake tenant. No membership guessing.
      let tenantId: string | null = null;
      const host = client.handshake.headers.host ?? '';
      const hostWithoutPort = this.normalizeHost(host.split(':')[0]);

      const rootDomain = this.normalizeHost(
        this.configService.get('app.rootDomain', { infer: true }) ??
          'crmsaudi.dev',
      );

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

      // 2. Resolve only explicit tenant hints from token or non-production handshake.
      if (!tenantId) {
        const explicitTenantHint =
          decoded.tenantId ??
          decoded.tenant_id ??
          (process.env.NODE_ENV !== 'production'
            ? (client.handshake.auth?.tenantId ??
              client.handshake.headers['x-tenant-id'])
            : null);

        if (typeof explicitTenantHint === 'string' && explicitTenantHint) {
          if (/^[0-9a-fA-F]{24}$/.test(explicitTenantHint)) {
            const tenant =
              await this.tenantsService.findById(explicitTenantHint);
            tenantId = tenant?.id ?? null;
          } else {
            const tenant =
              await this.tenantsService.findByAlias(explicitTenantHint);
            tenantId = tenant?.id ?? null;
          }
        }
      }

      if (
        tenantId &&
        dbUser &&
        !dbUser.tenants?.some(
          (membership: any) =>
            membership.tenantId?.toString() === tenantId?.toString(),
        )
      ) {
        this.logger.warn(
          `Client ${client.id} requested tenant ${tenantId} without membership. Disconnecting.`,
        );
        client.disconnect();
        return;
      }

      // 3. No tenant resolved → reject connection
      if (!tenantId) {
        this.logger.warn(
          `Client ${client.id} — cannot resolve explicit tenantId (host=${host}, user=${userId}). Disconnecting.`,
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
      source?: string;
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
        source: data.source ?? 'agent_ui',
        transport: 'socket',
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
          .to(
            `tenant:${client.data.tenantId}:conversation:${data.conversationId}`,
          )
          .emit('omni:message:new', {
            conversationId: data.conversationId,
            senderId: result.senderId ?? userId,
            senderName: result.senderName,
            senderAvatarUrl: result.senderAvatarUrl,
            senderType: 'agent',
            source: result.source ?? data.source ?? 'agent_ui',
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
   * Socket event: agent sends a media message.
   *
   * The frontend uploads the file via REST first (POST /files/upload),
   * then sends the fileId here for dispatch to the channel.
   */
  @SubscribeMessage('omni:message:send-media')
  async handleSendMedia(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      conversationId: string;
      fileId: string;
      caption?: string;
      mimeType?: string;
      fileName?: string;
      tempId?: string;
      idempotencyKey?: string;
      clientMessageId?: string;
    },
  ) {
    const user = client.data.user;
    if (!user) return { ok: false, error: 'Unauthenticated' };

    const userId = client.data.userId ?? user.id ?? user.sub;
    const tenantId = client.data.tenantId;
    if (!tenantId) return { ok: false, error: 'No tenant context' };

    if (!data?.conversationId || !data?.fileId) {
      return { ok: false, error: 'conversationId and fileId are required' };
    }

    this.logger.log(
      `Agent ${userId} sends media (fileId=${data.fileId}) to conversation ${data.conversationId}`,
    );

    try {
      const result = await this.outboundService.sendAgentMedia({
        tenantId,
        conversationId: data.conversationId,
        agentId: userId,
        media: {
          fileId: data.fileId,
          mimeType: data.mimeType || 'application/octet-stream',
          fileName: data.fileName || 'file',
          size: 0, // will be resolved from DB
        },
        caption: data.caption,
        idempotencyKey: data.idempotencyKey,
        clientMessageId: data.clientMessageId ?? data.tempId,
        source: 'agent_ui',
        transport: 'socket',
      });

      const ack = {
        ok: true,
        tempId: data.tempId,
        messageId: result.messageId,
        idempotencyKey: result.idempotencyKey ?? data.idempotencyKey,
        clientMessageId:
          result.clientMessageId ?? data.clientMessageId ?? data.tempId,
        timestamp: new Date().toISOString(),
      };

      // Broadcast to other agents watching this conversation
      if (!result.reused) {
        client
          .to(
            `tenant:${client.data.tenantId}:conversation:${data.conversationId}`,
          )
          .emit('omni:message:new', {
            conversationId: data.conversationId,
            senderId: result.senderId ?? userId,
            senderName: result.senderName,
            senderType: 'agent',
            source: result.source ?? 'agent_ui',
            messageType: result.messageType ?? 'file',
            content: data.caption || `📎 ${data.fileName || 'file'}`,
            messageId: ack.messageId,
            idempotencyKey: ack.idempotencyKey,
            clientMessageId: ack.clientMessageId,
            timestamp: ack.timestamp,
            metadata: { media: { fileId: data.fileId } },
          });
      }

      return ack;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`SendMedia error: ${errorMessage}`);
      return { ok: false, error: errorMessage };
    }
  }

  /**
   * Socket event: agent sends a WhatsApp template message.
   *
   * Template messages bypass the 24-hour reply window and are the only
   * way to re-engage a WhatsApp customer after the window expires.
   * The frontend sends the template name, language, and component parameters.
   */
  @SubscribeMessage('omni:message:send-template')
  async handleSendTemplate(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      conversationId: string;
      templateName: string;
      languageCode: string;
      components?: any[];
      tempId?: string;
      idempotencyKey?: string;
      clientMessageId?: string;
    },
  ) {
    const user = client.data.user;
    if (!user) return { ok: false, error: 'Unauthenticated' };

    const userId = client.data.userId ?? user.id ?? user.sub;
    const tenantId = client.data.tenantId;
    if (!tenantId) return { ok: false, error: 'No tenant context' };

    if (!data?.conversationId || !data?.templateName || !data?.languageCode) {
      return {
        ok: false,
        error: 'conversationId, templateName, and languageCode are required',
      };
    }

    this.logger.log(
      `Agent ${userId} sends template '${data.templateName}' to conversation ${data.conversationId}`,
    );

    try {
      const result = await this.outboundService.sendAgentTemplate({
        tenantId,
        conversationId: data.conversationId,
        agentId: userId,
        templateName: data.templateName,
        languageCode: data.languageCode,
        components: data.components,
        idempotencyKey: data.idempotencyKey,
        clientMessageId: data.clientMessageId ?? data.tempId,
        source: 'agent_ui',
        transport: 'socket',
      });

      const ack = {
        ok: true,
        tempId: data.tempId,
        messageId: result.messageId,
        idempotencyKey: result.idempotencyKey ?? data.idempotencyKey,
        clientMessageId:
          result.clientMessageId ?? data.clientMessageId ?? data.tempId,
        timestamp: new Date().toISOString(),
      };

      // Broadcast to other agents watching this conversation
      if (!result.reused) {
        client
          .to(
            `tenant:${client.data.tenantId}:conversation:${data.conversationId}`,
          )
          .emit('omni:message:new', {
            conversationId: data.conversationId,
            senderId: result.senderId ?? userId,
            senderName: result.senderName,
            senderType: 'agent',
            source: result.source ?? 'agent_ui',
            messageType: 'template',
            content: `📋 Template: ${data.templateName}`,
            messageId: ack.messageId,
            idempotencyKey: ack.idempotencyKey,
            clientMessageId: ack.clientMessageId,
            timestamp: ack.timestamp,
            metadata: {
              template: {
                name: data.templateName,
                language: data.languageCode,
                components: data.components,
              },
            },
          });
      }

      return ack;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`SendTemplate error: ${errorMessage}`);
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
  async handleInboundMessage(payload: any) {
    if (isDedicatedWorkerProcess()) {
      await this.publishSocketEvent('socket:omni:message:persisted', payload);
      return;
    }

    this.broadcastInboundMessage(payload);
  }

  private broadcastInboundMessage(payload: any) {
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
  async handleConversationCreated(event: {
    tenantId: string;
    conversation: any;
  }) {
    if (isDedicatedWorkerProcess()) {
      await this.publishSocketEvent('socket:omni:conversation:created', event);
      return;
    }

    this.broadcastConversationCreated(event);
  }

  private broadcastConversationCreated(event: {
    tenantId: string;
    conversation: any;
  }) {
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
  async handleConversationReopened(event: {
    tenantId: string;
    conversation: any;
  }) {
    if (isDedicatedWorkerProcess()) {
      await this.publishSocketEvent('socket:omni:conversation:reopened', event);
      return;
    }

    this.broadcastConversationReopened(event);
  }

  private broadcastConversationReopened(event: {
    tenantId: string;
    conversation: any;
  }) {
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
  async handleCustomerUpdated(event: {
    tenantId: string;
    conversationId: string;
    customer: any;
  }) {
    if (isDedicatedWorkerProcess()) {
      await this.publishSocketEvent(
        'socket:omni:conversation:customer_updated',
        event,
      );
      return;
    }

    this.broadcastCustomerUpdated(event);
  }

  private broadcastCustomerUpdated(event: {
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
  async handleMediaCached(event: {
    tenantId: string;
    conversationId: string;
    messageId: string;
    mediaProxyUrl: string;
  }) {
    if (isDedicatedWorkerProcess()) {
      await this.publishSocketEvent('socket:omni:message:media_cached', event);
      return;
    }

    this.broadcastMediaCached(event);
  }

  private broadcastMediaCached(event: {
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
    if (payload.transport === 'http') {
      this.logger.log(
        `Broadcasting HTTP-sent message to conversation ${payload.conversationId}`,
      );
      this.server
        .to(`tenant:${payload.tenantId}:conversation:${payload.conversationId}`)
        .emit('omni:message:new', {
          conversationId: payload.conversationId,
          senderId: payload.senderId,
          senderName: payload.senderName,
          senderAvatarUrl: payload.senderAvatarUrl,
          senderType: payload.senderType,
          direction: payload.direction,
          source: payload.source,
          messageType: payload.messageType,
          content: payload.content,
          messageId: payload.messageId,
          status: payload.status,
          idempotencyKey: payload.idempotencyKey,
          clientMessageId: payload.clientMessageId,
          timestamp: payload.timestamp,
          providerTimestamp: payload.timestamp,
          createdAt: payload.createdAt || payload.timestamp || new Date(),
          metadata: payload.metadata,
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

    // HIGH-04: Tenant-scope the room to prevent cross-tenant realtime leaks.
    // Without this, a tenant-A socket that learns a tenant-B conversationId
    // can join its room and receive live messages/typing/lock events.
    const tenantId = client.data.tenantId;
    if (!tenantId) {
      return { ok: false, error: 'No tenant context' };
    }

    const room = `tenant:${tenantId}:conversation:${data.conversationId}`;
    await client.join(room);
    return { ok: true, room };
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

    const tenantId = client.data.tenantId;
    if (!tenantId) {
      return { ok: false, error: 'No tenant context' };
    }

    const room = `tenant:${tenantId}:conversation:${data.conversationId}`;
    await client.leave(room);
    return { ok: true, room };
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

    client
      .to(`tenant:${client.data.tenantId}:conversation:${data.conversationId}`)
      .emit('omni:typing:start', {
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

    client
      .to(`tenant:${client.data.tenantId}:conversation:${data.conversationId}`)
      .emit('omni:typing:stop', {
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

    // HIGH-06: Redis-backed claim locks instead of in-memory Map.
    // In-memory Map fails in multi-process/pod: two agents on different pods
    // could claim the same conversation simultaneously.
    const claimKey = `omni:claim:${tenantId}:${conversationId}`;
    const existingClaim = await this.redis.get(claimKey);

    if (existingClaim && existingClaim !== userId) {
      // Collision! Another agent already claimed this conversation
      client.emit('omni:collision', {
        conversationId,
        claimedBy: existingClaim,
        message: 'This conversation is already claimed by another agent.',
      });

      this.logger.warn(
        `Collision: Agent ${userId} tried to claim conversation ` +
          `${conversationId} already claimed by ${existingClaim}`,
      );

      return {
        ok: false,
        error: 'Already claimed',
        claimedBy: existingClaim,
      };
    }

    // Atomically set the claim — NX ensures only one agent wins the race
    const acquired = await this.redis.set(
      claimKey,
      userId,
      'EX',
      OmniGateway.CLAIM_LOCK_TTL_SECONDS,
      'NX',
    );

    // If NX returns null, another pod won the race between our GET and SET
    if (!acquired && !existingClaim) {
      return { ok: false, error: 'Already claimed (race)' };
    }

    // Try to assign the conversation capacity to this agent
    const assigned = await this.presenceService.assignConversation(
      tenantId,
      userId,
    );

    if (!assigned) {
      await this.redis.del(claimKey).catch(() => undefined);
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

      await this.redis.del(claimKey).catch(() => undefined);
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
    await client.join(`tenant:${tenantId}:conversation:${conversationId}`);

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
      .to(`tenant:${event.tenantId}:conversation:${event.conversationId}`)
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
      .to(`tenant:${event.tenantId}:conversation:${event.conversationId}`)
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
      .to(`tenant:${event.tenantId}:conversation:${event.conversationId}`)
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

  /**
   * Broadcast contact export completion to the tenant room.
   * Called from Redis pub/sub subscription (cross-process) or
   * EventEmitter2 (same-process fallback).
   */
  private handleContactExportCompleted(event: {
    tenantId: string;
    userId: string;
    downloadUrl: string;
    expiresAt: string;
    recordCount: number;
  }) {
    const room = `tenant:${event.tenantId}`;
    this.logger.log(
      `Broadcasting contact export completed to room=${room} (user=${event.userId}, records=${event.recordCount})`,
    );
    this.server.to(room).emit('contact:export:completed', {
      userId: event.userId,
      downloadUrl: event.downloadUrl,
      expiresAt: event.expiresAt,
      recordCount: event.recordCount,
    });
  }

  /**
   * Generic handler for account/deal/ticket export completion events.
   * Mirrors contact export: broadcast to the tenant room with a module-prefixed
   * event name; the client filters by userId.
   */
  private handleModuleExportCompleted(
    module: 'account' | 'deal' | 'ticket',
    event: {
      tenantId: string;
      userId: string;
      downloadUrl: string;
      expiresAt: string;
      recordCount: number;
    },
  ) {
    const room = `tenant:${event.tenantId}`;
    this.logger.log(
      `Broadcasting ${module} export completed to room=${room} (user=${event.userId}, records=${event.recordCount})`,
    );
    this.server.to(room).emit(`${module}:export:completed`, {
      userId: event.userId,
      downloadUrl: event.downloadUrl,
      expiresAt: event.expiresAt,
      recordCount: event.recordCount,
    });
  }

  /**
   * Broadcast contact import completion to the user who triggered it.
   * Unlike export (tenant-wide), import results are only meaningful to the
   * initiating user, so we emit to the `agent:${userId}` room.
   */
  private handleContactImportCompleted(event: {
    tenantId: string;
    userId: string;
    jobId: string;
    fileName?: string;
    summary: {
      total: number;
      inserted: number;
      updated: number;
      skipped: number;
      errors: number;
    };
    reportUrl?: string;
  }) {
    const room = `agent:${event.userId}`;
    this.logger.log(
      `Broadcasting contact import completed to room=${room}, jobId=${event.jobId}`,
    );
    this.server.to(room).emit('contact:import:completed', {
      jobId: event.jobId,
      fileName: event.fileName,
      summary: event.summary,
      reportUrl: event.reportUrl,
    });
  }

  /**
   * Generic handler for account/deal/ticket import completion events.
   * Emits to the agent:${userId} room with module-prefixed event name.
   */
  private handleModuleImportCompleted(
    module: 'account' | 'deal' | 'ticket',
    event: {
      tenantId: string;
      userId: string;
      jobId: string;
      fileName?: string;
      summary: {
        total: number;
        inserted: number;
        updated: number;
        skipped: number;
        errors: number;
      };
      reportUrl?: string;
    },
  ) {
    const room = `agent:${event.userId}`;
    this.logger.log(
      `Broadcasting ${module} import completed to room=${room}, jobId=${event.jobId}`,
    );
    this.server.to(room).emit(`${module}:import:completed`, {
      jobId: event.jobId,
      fileName: event.fileName,
      summary: event.summary,
      reportUrl: event.reportUrl,
    });
  }

  private standardEvent(eventName: string, payload: any) {
    return {
      eventId: ulid(),
      event: eventName,
      conversationId: payload.conversationId,
      occurredAt: payload.occurredAt ?? new Date().toISOString(),
      version: Date.now(),
      payload,
    };
  }

  private async publishSocketEvent(channel: string, payload: unknown) {
    await this.redis.publish(channel, JSON.stringify(payload));
  }

  private normalizeHost(host?: string): string {
    return (host ?? '').toLowerCase().replace(/\.$/, '');
  }

  /**
   * Broadcasts CSAT submission to the agent who handled the conversation.
   * Emitted by CsatService when a customer submits their satisfaction rating.
   *
   * Socket events:
   *   - `omni:csat:received` → tenant room (dashboard widgets)
   *   - `omni:csat:received` → agent:${agentId} room (personal notification)
   */
  @OnEvent('csat.submitted')
  handleCsatSubmitted(event: {
    tenantId: string;
    conversationId: string;
    agentId: string | null;
    score: number;
    comment?: string;
    submittedAt: Date;
  }) {
    this.logger.log(
      `CSAT received: conversation=${event.conversationId} score=${event.score}`,
    );

    const payload = {
      conversationId: event.conversationId,
      score: event.score,
      comment: event.comment ?? null,
      submittedAt: event.submittedAt.toISOString(),
    };

    // Broadcast to entire tenant (for dashboard live updates)
    this.server
      .to(`tenant:${event.tenantId}`)
      .emit('omni:csat:received', payload);

    // Also notify the specific agent for personal alert
    if (event.agentId) {
      this.server
        .to(`agent:${event.agentId}`)
        .emit('omni:csat:received', payload);
    }
  }
}
