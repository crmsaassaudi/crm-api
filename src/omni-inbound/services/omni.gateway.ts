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
import { ClsService } from 'nestjs-cls';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AgentPresenceService } from './agent-presence.service';
import { AgentPresenceGateway } from './agent-presence.gateway';
import { AgentFallbackService } from './agent-fallback.service';
import { OutboundService } from '../../omni-outbound/outbound.service';
import { SessionService } from '../../auth/services/session.service';
import { TenantsService } from '../../tenants/tenants.service';
import { UsersService } from '../../users/users.service';
import { jwtDecode } from 'jwt-decode';
// @ts-expect-error -- cookie@0.x does not ship type declarations
import * as cookie from 'cookie';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '../../config/config.type';
import { ConversationLockService } from './conversation-lock.service';
import { ulid } from 'ulid';
import Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { isDedicatedWorkerProcess } from '../../config/runtime-role';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import { CrmRealtimeGateway } from './crm-realtime.gateway';
import {
  validateSendMessage,
  validateSendMedia,
  validateSendTemplate,
  validateSendInteractive,
  validateSendCarousel,
  validateReaction,
  validateTyping,
} from '../dto/gateway-dto';

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
    'socket:omni:message:persisted',
    'socket:omni:conversation:created',
    'socket:omni:conversation:reopened',
    'socket:omni:conversation:customer_updated',
    'socket:omni:message:media_cached',
    'socket:omni:message:status',
    'socket:omni:conversation:unread_reset',
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
    private readonly eventEmitter: EventEmitter2,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    private readonly cls: ClsService,
    private readonly crmRealtime: CrmRealtimeGateway,
  ) {}

  /**
   * Subscribe to Redis pub/sub channels for cross-process events.
   * Worker processes publish events via Redis; the API process
   * receives them here and broadcasts via Socket.IO.
   */
  onModuleInit() {
    if (isDedicatedWorkerProcess()) return; // Only API/all-in-one process needs to subscribe

    // Share Socket.IO server with CRM realtime gateway
    this.crmRealtime.setServer(this.server);

    const allChannels = [
      ...this.socketEventChannels,
      ...CrmRealtimeGateway.REDIS_CHANNELS,
    ];

    const sub = this.redis.duplicate();
    void sub.subscribe(...allChannels, (err) => {
      if (err) {
        this.logger.error('Failed to subscribe to Redis socket channels', err);
      } else {
        this.logger.log(
          `Subscribed to Redis socket channels: ${allChannels.join(', ')}`,
        );
      }
    });

    sub.on('message', (channel: string, message: string) => {
      try {
        const event = JSON.parse(message);

        // Delegate CRM events (export/import) to CrmRealtimeGateway
        if (this.crmRealtime.handleRedisMessage(channel, event)) {
          return;
        }

        // Handle omni events
        switch (channel) {
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
          case 'socket:omni:message:status':
            this.broadcastMessageStatus(event);
            break;
          case 'socket:omni:conversation:unread_reset':
            this.broadcastUnreadReset(event);
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

      // 4. Resolve MongoDB _id from keycloakId
      const { userId, dbUser } = await this.resolveMongoUserId(
        client.id,
        keycloakUserId,
      );

      // 5. Resolve tenantId from subdomain or explicit hints
      const tenantId = await this.resolveTenantId(client, decoded);

      if (
        tenantId &&
        dbUser &&
        !dbUser.tenants?.some((m: any) => m.tenantId?.toString() === tenantId)
      ) {
        this.logger.warn(
          `Client ${client.id} requested tenant ${tenantId} without membership. Disconnecting.`,
        );
        client.disconnect();
        return;
      }

      if (!tenantId) {
        this.logger.warn(
          `Client ${client.id} — cannot resolve tenantId (user=${userId}). Disconnecting.`,
        );
        client.disconnect();
        return;
      }

      this.logger.debug(
        `JWT decoded for ${client.id}: tenantId=${tenantId}, keycloakId=${keycloakUserId}, resolvedUserId=${userId}`,
      );

      client.data.tenantId = tenantId;
      client.data.userId = userId;

      await client.join(`tenant:${tenantId}`);
      await client.join(`agent:${userId}`);
      this.logger.log(
        `Agent ${userId} connected to /omni, joined tenant:${tenantId} and agent:${userId}`,
      );

      await this.presenceGateway.onAgentConnected(tenantId, userId, client.id, {
        skills: dbUser?.skills,
        maxCapacity: dbUser?.omniMaxCapacity ?? undefined,
      });

      await this.agentFallbackService.onAgentReconnected(tenantId, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Connection error for client ${client.id}: ${message}`);
      client.disconnect();
    }
  }

  /** Resolve MongoDB _id from keycloakId — falls back to keycloakId if not found. */
  private async resolveMongoUserId(
    clientId: string,
    keycloakUserId: string,
  ): Promise<{ userId: string; dbUser: any | null }> {
    try {
      const dbUser = await this.usersService.findByKeycloakIdAndProvider({
        keycloakId: keycloakUserId,
        provider: 'email',
      });
      if (dbUser) {
        const userId = dbUser.id.toString();
        this.logger.log(
          `Resolved keycloakId ${keycloakUserId} → MongoDB _id ${userId}`,
        );
        return { userId, dbUser };
      }
      this.logger.warn(
        `[${clientId}] Could not resolve MongoDB _id for keycloakId ${keycloakUserId} — using fallback`,
      );
      return { userId: keycloakUserId, dbUser: null };
    } catch (err: any) {
      this.logger.warn(
        `[${clientId}] Failed to resolve MongoDB _id: ${err.message} — using fallback`,
      );
      return { userId: keycloakUserId, dbUser: null };
    }
  }

  /** Resolve tenantId: subdomain first, then explicit token/handshake hint. */
  private async resolveTenantId(
    client: Socket,
    decoded: any,
  ): Promise<string | null> {
    const host = client.handshake.headers.host ?? '';
    const hostWithoutPort = this.normalizeHost(host.split(':')[0]);
    const rootDomain = this.normalizeHost(
      this.configService.get('app.rootDomain', { infer: true }) ??
        'crmsaudi.dev',
    );

    // 1. Subdomain resolution
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
          this.logger.log(
            `Resolved tenant alias "${subdomain}" → ${tenant.id}`,
          );
          return tenant.id;
        }
        this.logger.warn(`Tenant alias "${subdomain}" not found in DB`);
      }
    }

    // 2. Explicit hint from token or non-prod handshake
    const hint =
      decoded.tenantId ??
      decoded.tenant_id ??
      (process.env.NODE_ENV !== 'production'
        ? (client.handshake.auth?.tenantId ??
          client.handshake.headers['x-tenant-id'])
        : null);

    if (typeof hint === 'string' && hint) {
      const tenant = /^[0-9a-fA-F]{24}$/.test(hint)
        ? await this.tenantsService.findById(hint)
        : await this.tenantsService.findByAlias(hint);
      return tenant?.id ?? null;
    }

    return null;
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

    // T-037: Validate payload before processing
    const validationError = validateSendMessage(data);
    if (validationError) return { ok: false, error: validationError };

    try {
      // Wrap in tenant CLS context — WebSocket handlers don't have HTTP
      // interceptor pipeline, so CLS is empty. Mongoose tenant filter
      // plugin requires activeTenantId in CLS for all DB operations.
      const result = await runWithTenantContext(this.cls, tenantId, () =>
        this.outboundService.sendAgentMessage({
          tenantId,
          conversationId: data.conversationId,
          agentId: userId,
          content: data.content,
          messageType: data.messageType,
          idempotencyKey: data.idempotencyKey,
          clientMessageId: data.clientMessageId ?? data.tempId,
          source: data.source ?? 'agent_ui',
          transport: 'socket',
        }),
      );

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

    // T-037: Validate payload before processing
    const validationError = validateSendMedia(data);
    if (validationError) return { ok: false, error: validationError };

    if (!data?.conversationId || !data?.fileId) {
      return { ok: false, error: 'conversationId and fileId are required' };
    }

    this.logger.log(
      `Agent ${userId} sends media (fileId=${data.fileId}) to conversation ${data.conversationId}`,
    );

    try {
      const result = await runWithTenantContext(this.cls, tenantId, () =>
        this.outboundService.sendAgentMedia({
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
        }),
      );

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
            metadata: {
              media: {
                fileId: data.fileId,
                mimeType: data.mimeType,
                fileName: data.fileName,
              },
            },
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

    // T-037: Validate template payload
    const validationError = validateSendTemplate(data);
    if (validationError) {
      return { ok: false, error: validationError };
    }

    this.logger.log(
      `Agent ${userId} sends template '${data.templateName}' to conversation ${data.conversationId}`,
    );

    try {
      const result = await runWithTenantContext(this.cls, tenantId, () =>
        this.outboundService.sendAgentTemplate({
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
        }),
      );

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
   * Socket event: agent sends an interactive button message.
   */
  @SubscribeMessage('omni:message:send-interactive')
  async handleSendInteractive(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      conversationId: string;
      body: string;
      buttons: Array<{
        id?: string;
        title: string;
        type?: string;
        url?: string;
      }>;
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

    const validationError = validateSendInteractive(data);
    if (validationError) return { ok: false, error: validationError };

    this.logger.log(
      `Agent ${userId} sends interactive (${data.buttons?.length} buttons) to ${data.conversationId}`,
    );

    try {
      const result = await runWithTenantContext(this.cls, tenantId, () =>
        this.outboundService.sendAgentInteractive({
          tenantId,
          conversationId: data.conversationId,
          agentId: userId,
          body: data.body,
          buttons: data.buttons,
          idempotencyKey: data.idempotencyKey,
          clientMessageId: data.clientMessageId ?? data.tempId,
          source: 'agent_ui',
          transport: 'socket',
        }),
      );

      const ack = {
        ok: true,
        tempId: data.tempId,
        messageId: result.messageId,
        idempotencyKey: result.idempotencyKey ?? data.idempotencyKey,
        clientMessageId:
          result.clientMessageId ?? data.clientMessageId ?? data.tempId,
        timestamp: new Date().toISOString(),
      };

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
            messageType: 'interactive',
            content: data.body,
            messageId: ack.messageId,
            idempotencyKey: ack.idempotencyKey,
            clientMessageId: ack.clientMessageId,
            timestamp: ack.timestamp,
            metadata: { buttons: data.buttons },
          });
      }

      return ack;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`SendInteractive error: ${errorMessage}`);
      return { ok: false, error: errorMessage };
    }
  }

  /**
   * Socket event: agent sends a carousel card message.
   */
  @SubscribeMessage('omni:message:send-carousel')
  async handleSendCarousel(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      conversationId: string;
      content?: string;
      cards: Array<{
        title?: string;
        subtitle?: string;
        imageUrl?: string;
        buttons?: Array<{
          id?: string;
          title: string;
          type?: string;
          url?: string;
        }>;
      }>;
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

    const validationError = validateSendCarousel(data);
    if (validationError) return { ok: false, error: validationError };

    this.logger.log(
      `Agent ${userId} sends carousel (${data.cards?.length} cards) to ${data.conversationId}`,
    );

    try {
      const result = await runWithTenantContext(this.cls, tenantId, () =>
        this.outboundService.sendAgentCarousel({
          tenantId,
          conversationId: data.conversationId,
          agentId: userId,
          content: data.content,
          cards: data.cards,
          idempotencyKey: data.idempotencyKey,
          clientMessageId: data.clientMessageId ?? data.tempId,
          source: 'agent_ui',
          transport: 'socket',
        }),
      );

      const ack = {
        ok: true,
        tempId: data.tempId,
        messageId: result.messageId,
        idempotencyKey: result.idempotencyKey ?? data.idempotencyKey,
        clientMessageId:
          result.clientMessageId ?? data.clientMessageId ?? data.tempId,
        timestamp: new Date().toISOString(),
      };

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
            messageType: 'carousel',
            content:
              data.content ??
              data.cards.map((c) => c.title).join(' | ') ??
              'Carousel',
            messageId: ack.messageId,
            idempotencyKey: ack.idempotencyKey,
            clientMessageId: ack.clientMessageId,
            timestamp: ack.timestamp,
            metadata: { cards: data.cards },
          });
      }

      return ack;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`SendCarousel error: ${errorMessage}`);
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

  // ── Message Status (delivery receipts) ───────────────────────────────

  /**
   * Listener for 'livechat.message.status' domain event.
   * Emitted by MessageStatusService when visitor acks (delivered) or reads messages.
   * Broadcasts 'omni:message:status' to the agent tenant room.
   */
  @OnEvent('livechat.message.status')
  async handleMessageStatus(payload: {
    tenantId: string;
    conversationId: string;
    messageIds: string[];
    status: 'delivered' | 'read';
  }) {
    if (isDedicatedWorkerProcess()) {
      await this.publishSocketEvent('socket:omni:message:status', payload);
      return;
    }

    this.broadcastMessageStatus(payload);
  }

  private broadcastMessageStatus(payload: {
    tenantId: string;
    conversationId: string;
    messageIds: string[];
    status: string;
  }) {
    const room = `tenant:${payload.tenantId}`;
    this.logger.debug(
      `Broadcasting message status '${payload.status}' for ${payload.messageIds.length} msg(s) ` +
        `in conversation ${payload.conversationId} to room=${room}`,
    );
    this.server.to(room).emit('omni:message:status', {
      conversationId: payload.conversationId,
      messageIds: payload.messageIds,
      status: payload.status,
    });
  }

  /**
   * Listener for 'omni.conversation.unread_reset' domain event.
   * Emitted by OmniController.markAsRead() after DB unread count is reset.
   * Broadcasts 'omni:conversation:unread_reset' to all agents in the tenant room
   * so the sidebar conversation list updates in real-time.
   */
  @OnEvent('omni.conversation.unread_reset')
  async handleUnreadReset(payload: {
    tenantId: string;
    conversationId: string;
  }) {
    if (isDedicatedWorkerProcess()) {
      await this.publishSocketEvent(
        'socket:omni:conversation:unread_reset',
        payload,
      );
      return;
    }

    this.broadcastUnreadReset(payload);
  }

  private broadcastUnreadReset(payload: {
    tenantId: string;
    conversationId: string;
  }) {
    const room = `tenant:${payload.tenantId}`;
    this.logger.debug(
      `Broadcasting unread_reset for conversation ${payload.conversationId} to room=${room}`,
    );
    this.server.to(room).emit('omni:conversation:unread_reset', {
      conversationId: payload.conversationId,
    });
  }

  // ── Reactions (unified across all channels) ────────────────────────────

  /**
   * Listener for 'omni.reaction.persisted' domain event.
   * Emitted by ReactionService after a reaction is saved to DB.
   * Broadcasts 'omni:reaction:update' to the agent tenant room.
   */
  @OnEvent('omni.reaction.persisted')
  handleReactionPersisted(payload: {
    tenantId: string;
    conversationId: string;
    messageId: string;
    reactions: Array<{
      emoji: string;
      senderId: string;
      senderType: string;
      createdAt: Date;
    }>;
    trigger: {
      emoji: string;
      senderId: string;
      senderType: string;
      action: string;
    };
  }) {
    const room = `tenant:${payload.tenantId}`;
    this.logger.debug(
      `Broadcasting reaction update on message ${payload.messageId} to room=${room}`,
    );
    this.server.to(room).emit('omni:reaction:update', {
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      reactions: payload.reactions,
      trigger: payload.trigger,
    });
  }

  /**
   * Socket event: agent sends an emoji reaction from the CRM UI.
   * Emits into the unified reaction pipeline so it's persisted and broadcast.
   */
  @SubscribeMessage('omni:reaction:send')
  handleAgentReaction(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      conversationId: string;
      messageId: string;
      emoji: string;
      action?: 'react' | 'unreact';
    },
  ) {
    const user = client.data.user;
    if (!user) return { ok: false, error: 'Unauthenticated' };

    const userId = client.data.userId ?? user.id ?? user.sub;
    const tenantId = client.data.tenantId;
    if (!tenantId) return { ok: false, error: 'No tenant context' };

    // T-037: Validate reaction payload
    const validationError = validateReaction(data);
    if (validationError) {
      return { ok: false, error: validationError };
    }

    this.logger.debug(
      `Agent ${userId} reacted ${data.emoji} on message ${data.messageId}`,
    );

    this.eventEmitter.emit('omni.reaction.inbound', {
      tenantId,
      channelType: 'livechat', // Agent reactions are always internal
      channelId: '',
      messageId: data.messageId,
      externalMessageId: data.messageId,
      senderId: userId,
      senderType: 'agent',
      emoji: data.emoji,
      action: data.action ?? 'react',
      timestamp: new Date(),
    });

    return { ok: true };
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

    // T-037: Validate typing payload
    const validationError = validateTyping(data);
    if (validationError) return;

    const userId = client.data.userId ?? user.id ?? user.sub;
    const tenantId = client.data.tenantId;

    // Broadcast to other agents in the conversation room
    client
      .to(`tenant:${tenantId}:conversation:${data.conversationId}`)
      .emit('omni:typing:start', {
        conversationId: data.conversationId,
        userId,
        userName: user.name ?? 'Agent',
      });

    // Bridge to livechat visitor (LivechatVisitorBridge picks this up).
    // Emit BEFORE heartbeat so that the visitor always sees typing,
    // even if the conversation lock heartbeat fails.
    this.eventEmitter.emit('omni.agent.typing.livechat', {
      tenantId,
      conversationId: data.conversationId,
      visitorId: null, // Bridge resolves via conversation lookup
      isTyping: true,
      agentName: user.name ?? 'Agent',
    });

    // NOTE: We do NOT emit 'livechat.agent.read' here.
    // The agent opening/selecting the conversation already triggers markAsRead()
    // via OmniController, which emits livechat.agent.read. Emitting it again on
    // every typing event would cause redundant DB queries (markReadByAgent)
    // with no benefit — by the time the agent is typing, markAsRead has already run.

    // Heartbeat for conversation lock (collision detection)
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
      }
    }
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

    // Bridge typing stop to livechat visitor
    this.eventEmitter.emit('omni.agent.typing.livechat', {
      tenantId: client.data.tenantId,
      conversationId: data.conversationId,
      visitorId: null,
      isTyping: false,
    });
  }

  /**
   * G3 FIX — Forward visitor typing indicator to agents.
   *
   * Emitted by LivechatGateway when a visitor types or stops typing.
   * Broadcasts `omni:visitor:typing` to all agents in the conversation room
   * so agent UI can show a typing bubble for the visitor.
   *
   * Note: This is the reverse of agent→visitor (which goes via LivechatVisitorBridge).
   */
  @OnEvent('omni.visitor.typing.livechat')
  handleVisitorTyping(event: {
    conversationId: string;
    visitorId: string;
    tenantId: string;
    isTyping: boolean;
  }) {
    const room = `tenant:${event.tenantId}:conversation:${event.conversationId}`;
    this.server.to(room).emit('omni:visitor:typing', {
      conversationId: event.conversationId,
      visitorId: event.visitorId,
      isTyping: event.isTyping,
    });
    this.logger.debug(
      `Visitor ${event.visitorId} typing=${event.isTyping} → room ${room}`,
    );
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

    // Pre-check capacity before incrementing to avoid over-assigning.
    // The old assignConversation returned boolean — the new void version
    // always increments, so we guard here first.
    const agentPresence = await this.presenceService.getPresence(
      tenantId,
      userId,
    );
    if (
      agentPresence &&
      agentPresence.activeConversations >= agentPresence.maxCapacity
    ) {
      await this.redis.del(claimKey).catch(() => undefined);
      return { ok: false, error: 'Agent at capacity' };
    }

    // Atomically increment the conversation counter
    await this.presenceService.assignConversation(tenantId, userId);

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
  async handleAssignmentChanged(event: {
    tenantId: string;
    conversationId: string;
    agentId: string | null;
    oldAgentId: string | null;
    groupId?: string | null;
    agentName?: string | null;
  }) {
    this.logger.log(
      `Broadcasting assignment: ${event.conversationId} → agent=${event.agentId ?? 'unassigned'}, group=${event.groupId ?? 'unchanged'}`,
    );

    // Resolve agent name if not provided by the emitter
    let agentName = event.agentName ?? null;
    if (event.agentId && !agentName) {
      try {
        const users = await this.usersService.findByIdsGlobal([event.agentId]);
        const u = users[0];
        agentName = u
          ? (([u.firstName, u.lastName].filter(Boolean).join(' ').trim() ||
              u.email) ??
            null)
          : null;
      } catch {
        agentName = null;
      }
    }

    this.server
      .to(`tenant:${event.tenantId}`)
      .emit('omni:conversation:assigned', {
        conversationId: event.conversationId,
        agentId: event.agentId,
        agentName,
        oldAgentId: event.oldAgentId,
        groupId: event.groupId,
        timestamp: new Date().toISOString(),
      });
  }

  @OnEvent('omni.bot.disabled')
  handleBotDisabled(event: {
    tenantId: string;
    conversationId: string;
    reason: string;
  }) {
    this.server
      .to(`tenant:${event.tenantId}`)
      .emit('omni:conversation:bot_state', {
        conversationId: event.conversationId,
        bot: { enabled: false, status: 'handoff' },
        reason: event.reason,
        timestamp: new Date().toISOString(),
      });
  }

  @OnEvent('omni.bot.enabled')
  handleBotEnabled(event: { tenantId: string; conversationId: string }) {
    this.server
      .to(`tenant:${event.tenantId}`)
      .emit('omni:conversation:bot_state', {
        conversationId: event.conversationId,
        bot: { enabled: true, status: 'active' },
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
