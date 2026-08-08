import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { Inject, Logger, OnModuleInit } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
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
  validateConversationId,
} from '../dto/gateway-dto';
import { TENANT_HEADER } from '../../common/tenant/tenant-header.policy';
import { DataVisibilityInterceptor } from '../../data-visibility/data-visibility.interceptor';
import { AuthzPermissionCacheService } from '../../common/permissions/authz-permission-cache.service';
import { PERMISSION_REGISTRY } from '../../common/permissions/permission.constants';
import {
  ConversationAudienceService,
  type SocketScope,
} from './conversation-audience.service';
import { OmniEvents } from '../domain/omni-events';
import { SlaEvents } from '../../sla-policies/clock/sla-events';
import type { SlaBreachedEvent } from '../../sla-policies/clock/sla-events';

/**
 * Primary Socket.IO gateway for omni-channel real-time messaging.
 *
 * Events, by direction:
 *   C → S  omni:message:send             agent sends a reply
 *   C → S  omni:conversation:claim       agent claims a conversation
 *   C ↔ S  omni:typing:start / :stop     typing indicators
 *   S → C  omni:message:new              new inbound message (from webhook)
 *   S → C  omni:message:ack              server confirms message receipt
 *   S → C  omni:conversation:claimed     broadcast who claimed
 *   S → C  omni:collision                two agents claim the same conversation
 */
// Env-driven allowlist instead of origin: '*'. origin: '*' + credentials: true
// would let any site open a socket with the user's cookies.
const OMNI_CORS_ALLOWLIST = process.env.FRONTEND_DOMAIN
  ? process.env.FRONTEND_DOMAIN.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : ['http://localhost:3000'];
const OMNI_CORS_ROOT_DOMAIN =
  process.env.APP_ROOT_DOMAIN?.trim().toLowerCase() || null;

/**
 * CORS origin check for the /omni socket. Multi-tenant: every tenant is served
 * at its own subdomain of APP_ROOT_DOMAIN (e.g. master.crmsaudi.dev), so the
 * root domain and all of its subdomains must be allowed — not just the single
 * FRONTEND_DOMAIN entry. Explicit FRONTEND_DOMAIN origins are also honored.
 */
function omniCorsOrigin(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void {
  if (!origin) return callback(null, true);
  let host: string | null = null;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    host = null;
  }
  if (
    host &&
    OMNI_CORS_ROOT_DOMAIN &&
    (host === OMNI_CORS_ROOT_DOMAIN ||
      host.endsWith(`.${OMNI_CORS_ROOT_DOMAIN}`))
  ) {
    return callback(null, true);
  }
  if (OMNI_CORS_ALLOWLIST.includes(origin)) return callback(null, true);
  return callback(new Error(`Origin ${origin} not allowed by CORS`));
}

@WebSocketGateway({
  namespace: '/omni',
  cors: {
    origin: omniCorsOrigin,
    credentials: true,
  },
})
export class OmniGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  @WebSocketServer()
  server!: Namespace;

  private readonly logger = new Logger(OmniGateway.name);
  private readonly socketEventChannels = [
    'socket:omni:message:persisted',
    'socket:omni:conversation:created',
    'socket:omni:conversation:reopened',
    'socket:omni:conversation:customer_updated',
    'socket:omni:message:media_cached',
    'socket:omni:message:status',
    'socket:omni:conversation:unread_reset',
    'socket:omni:work_offer:created',
    'socket:omni:transfer:changed',
    'socket:omni:conversation:sla',
    'socket:omni:bot:state',
  ] as const;

  // Claim lock TTL in seconds. Redis-backed claim locks auto-expire
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
    private readonly dataVisibility: DataVisibilityInterceptor,
    private readonly authzCache: AuthzPermissionCacheService,
    private readonly audience: ConversationAudienceService,
  ) {}

  /**
   * Deliver a conversation event to the agents allowed to see that conversation.
   *
   * Every conversation broadcast goes through here. `this.server.to('tenant:…')`
   * sends to every agent in the tenant, which bypassed the channel support pool,
   * the owner visibility scope and PII masking all at once — see
   * ConversationAudienceService for why the filter is per-socket.
   *
   * Never rejects. Every caller fires this and moves on (`void`), because a
   * broadcast is a side effect of work that has already been committed — so a
   * rejection here has no caller left to handle it and surfaces as a process
   * `unhandledRejection` instead of a log line. A broadcast that fails must not
   * be able to take the process down; it degrades to one agent missing one
   * realtime update, and the logged event name says which.
   */
  private async emitToConversationAudience(
    conversationId: string,
    tenantId: string,
    event: string,
    payload: unknown,
    facts?: { channelId?: string | null; assignedAgentId?: string | null },
  ): Promise<void> {
    try {
      await this.audience.emitToConversation(
        this.server,
        { tenantId, conversationId, facts },
        event,
        payload,
      );
    } catch (err) {
      this.logger.error(
        `Failed to broadcast ${event} for conversation ${conversationId} (tenant ${tenantId})`,
        err instanceof Error ? err.stack : err,
      );
    }
  }

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
          case 'socket:omni:work_offer:created':
            this.broadcastWorkOffer(event);
            break;
          case 'socket:omni:transfer:changed':
            this.broadcastTransfer(event);
            break;
          case 'socket:omni:conversation:sla':
            this.broadcastSlaBreached(event);
            break;
          case 'socket:omni:bot:state':
            this.broadcastBotState(event);
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

  // Connection lifecycle

  async handleConnection(client: Socket) {
    try {
      const auth = await this.authenticateSocket(client);
      if (!auth) return;

      const tenantId = await this.validateTenantMembership(
        client,
        auth.decoded,
        auth.userId,
        auth.dbUser,
      );
      if (!tenantId) return;

      await this.setupAgentSocket(client, tenantId, auth.userId, auth.dbUser);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Connection error for client ${client.id}: ${message}`);
      client.disconnect();
    }
  }

  /**
   * Authenticate the socket connection: parse session cookie, validate session,
   * decode JWT, and resolve the MongoDB user ID.
   * Returns null (and disconnects) on any authentication failure.
   */
  private async authenticateSocket(client: Socket): Promise<{
    decoded: any;
    userId: string;
    dbUser: any;
  } | null> {
    const rawCookie = client.handshake.headers.cookie;
    const cookies = rawCookie ? cookie.parse(rawCookie) : {};
    const sid = cookies['sid'];

    if (!sid) {
      this.logger.warn(`Client ${client.id} has no session cookie (sid)`);
      client.disconnect();
      return null;
    }

    const session = await this.sessionService.getSession(sid);
    if (!session) {
      this.logger.warn(`Client ${client.id} has invalid/expired session`);
      client.disconnect();
      return null;
    }

    const decoded: any = jwtDecode(session.idToken ?? session.accessToken);
    if (!decoded) {
      this.logger.warn(`Client ${client.id} has malformed token in session`);
      client.disconnect();
      return null;
    }

    client.data.user = decoded;
    const keycloakUserId = decoded.id ?? decoded.sub;
    const { userId, dbUser } = await this.resolveMongoUserId(
      client.id,
      keycloakUserId,
    );

    return { decoded, userId, dbUser };
  }

  /**
   * Validate that the resolved tenant exists and the user has membership.
   * Returns the tenantId on success, or null (and disconnects) on failure.
   */
  private async validateTenantMembership(
    client: Socket,
    decoded: any,
    userId: string,
    dbUser: any,
  ): Promise<string | null> {
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
      return null;
    }

    if (!tenantId) {
      this.logger.warn(
        `Client ${client.id} — cannot resolve tenantId (user=${userId}). Disconnecting.`,
      );
      client.disconnect();
      return null;
    }

    this.logger.debug(
      `JWT decoded for ${client.id}: tenantId=${tenantId}, keycloakId=${decoded.id ?? decoded.sub}, resolvedUserId=${userId}`,
    );

    return tenantId;
  }

  /**
   * Finalize the agent socket: persist context, join rooms, register presence,
   * and trigger reconnection handlers.
   */
  private async setupAgentSocket(
    client: Socket,
    tenantId: string,
    userId: string,
    dbUser: any,
  ): Promise<void> {
    client.data.tenantId = tenantId;
    client.data.userId = userId;
    client.data.scope = await this.resolveSocketScope(tenantId, userId);

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
  }

  /**
   * Resolve what this socket may see, once, at connect time.
   *
   * Reuses `DataVisibilityInterceptor.resolveVisibility()` — the same computation
   * the REST layer runs per request — inside a CLS scope seeded with this
   * principal. Reimplementing the axes here would be a second answer to the same
   * question, and the two would drift.
   *
   * Fail-closed: an unresolvable scope yields empty arrays on both axes, so the
   * socket receives nothing rather than everything.
   */
  private async resolveSocketScope(
    tenantId: string,
    userId: string,
  ): Promise<SocketScope> {
    try {
      return await this.cls.runWith(
        { tenantId, activeTenantId: tenantId, userId } as any,
        async () => {
          await this.dataVisibility.resolveVisibility();
          const channelIds = this.cls.get('servableChannelIds');
          const byModule =
            (this.cls.get('dataVisibilityByModule') as Record<
              string,
              { ownerIds: string[] | null }
            >) ?? {};
          const ownerIds =
            byModule.Conversation?.ownerIds ?? this.cls.get('visibleOwnerIds');
          const { effective } = await this.authzCache.explainForUser(
            userId,
            tenantId,
          );

          const permissions = new Set(effective);
          return {
            channelIds: Array.isArray(channelIds)
              ? channelIds.map(String)
              : null,
            ownerIds: Array.isArray(ownerIds) ? ownerIds.map(String) : null,
            includeUnowned: this.cls.get('includeUnownedInScope') === true,
            canUnmask: permissions.has(
              PERMISSION_REGISTRY.omni_channel.unmask!,
            ),
            permissions,
          };
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Socket scope resolution failed for user ${userId}, failing closed: ${message}`,
      );
      return {
        channelIds: [],
        ownerIds: [],
        includeUnowned: false,
        canUnmask: false,
        permissions: new Set<string>(),
      };
    }
  }

  /** Resolve MongoDB _id from keycloakId — falls back to keycloakId if not found. */
  private async resolveMongoUserId(
    clientId: string,
    keycloakUserId: string,
  ): Promise<{ userId: string; dbUser: any }> {
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
      if (this.isValidSubdomain(subdomain)) {
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

    // 2. Explicit hint — from the JWT, or the socket handshake.
    //
    // The handshake hint (auth.tenantId / x-tenant-id) is honored in ALL envs,
    // including production. This is required because the client may connect the
    // socket to a non-tenant host (e.g. wss://api.crmsaudi.dev, configured via
    // VITE_SOCKET_URL) where the subdomain branch above cannot apply — the
    // frontend then passes the tenant it is viewing via `auth.tenantId`.
    //
    // Trusting a client-supplied hint here is safe: validateTenantMembership()
    // re-checks that the resolved tenant is one this user actually belongs to
    // before the socket is accepted, so a user cannot claim a foreign tenant.
    const hint =
      decoded.tenantId ??
      decoded.tenant_id ??
      client.handshake.auth?.tenantId ??
      client.handshake.headers[TENANT_HEADER];

    const fromHint = await this.resolveTenantHint(hint);
    if (fromHint) return fromHint;

    // 3. Last resort: if the JWT exposes exactly one tenant membership, use it.
    // Tokens carry memberships as a `tenants` / `tenant_ids` array (see
    // auth.service jitProvision). This keeps single-tenant users working even
    // when neither a subdomain nor an explicit hint is available.
    const claimTenants: unknown = decoded.tenants ?? decoded.tenant_ids;
    if (Array.isArray(claimTenants) && claimTenants.length === 1) {
      const fromClaim = await this.resolveTenantHint(claimTenants[0]);
      if (fromClaim) return fromClaim;
    }

    return null;
  }

  /**
   * Resolve a tenant hint (a 24-hex ObjectId or an alias) to a tenant id.
   * Returns null when the hint is missing, malformed, or matches no tenant.
   */
  private async resolveTenantHint(hint: unknown): Promise<string | null> {
    if (typeof hint !== 'string' || !hint) return null;
    const tenant = /^[0-9a-fA-F]{24}$/.test(hint)
      ? await this.tenantsService.findById(hint)
      : await this.tenantsService.findByAlias(hint);
    return tenant?.id ?? null;
  }

  private isValidSubdomain(subdomain: string): boolean {
    return (
      Boolean(subdomain) &&
      !subdomain.includes('.') &&
      !this.SYSTEM_SUBDOMAINS.includes(subdomain.toLowerCase())
    );
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

  // Messaging

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

    // Validate payload before processing
    const validationError = validateSendMessage(data);
    if (validationError) return { ok: false, error: validationError };

    // Socket handlers bypass the HTTP guards, so the permission and the record
    // ACL are checked here — see authorizeSocketAction.
    const denied = await this.authorizeSocketAction(
      client,
      'reply',
      data.conversationId,
    );
    if (denied) return denied;

    try {
      // Wrap in tenant CLS context — WebSocket handlers don't have HTTP
      // interceptor pipeline, so CLS is empty. Mongoose tenant filter
      // plugin requires activeTenantId in CLS for all DB operations.
      const result = await runWithTenantContext(this.cls, tenantId, () =>
        this.outboundService.queueAgentMessage({
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

    const validationError = validateSendMedia(data);
    if (validationError) return { ok: false, error: validationError };

    // Socket handlers bypass the HTTP guards, so the permission and the record
    // ACL are checked here — see authorizeSocketAction.
    const denied = await this.authorizeSocketAction(
      client,
      'reply',
      data.conversationId,
    );
    if (denied) return denied;

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
            mimeType: data.mimeType ?? 'application/octet-stream',
            fileName: data.fileName ?? 'file',
            size: 0,
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

      this.broadcastAgentMessage(client, tenantId, result, data, ack, userId);

      return ack;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`SendMedia error: ${errorMessage}`);
      return { ok: false, error: errorMessage };
    }
  }

  private broadcastAgentMessage(
    client: Socket,
    tenantId: string,
    result: any,
    data: any,
    ack: any,
    userId: string,
  ) {
    if (result.reused) return;

    client
      .to(`tenant:${tenantId}:conversation:${data.conversationId}`)
      .emit('omni:message:new', {
        conversationId: data.conversationId,
        senderId: result.senderId ?? userId,
        senderName: result.senderName,
        senderType: 'agent',
        source: result.source ?? 'agent_ui',
        messageType: result.messageType ?? 'file',
        content: data.caption ?? `📎 ${data.fileName ?? 'file'}`,
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

    // Validate template payload
    const validationError = validateSendTemplate(data);
    if (validationError) {
      return { ok: false, error: validationError };
    }

    // Socket handlers bypass the HTTP guards, so the permission and the record
    // ACL are checked here — see authorizeSocketAction.
    const denied = await this.authorizeSocketAction(
      client,
      'reply',
      data.conversationId,
    );
    if (denied) return denied;

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

    // Socket handlers bypass the HTTP guards, so the permission and the record
    // ACL are checked here — see authorizeSocketAction.
    const denied = await this.authorizeSocketAction(
      client,
      'reply',
      data.conversationId,
    );
    if (denied) return denied;

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

    // Socket handlers bypass the HTTP guards, so the permission and the record
    // ACL are checked here — see authorizeSocketAction.
    const denied = await this.authorizeSocketAction(
      client,
      'reply',
      data.conversationId,
    );
    if (denied) return denied;

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
    // The message event already carries the channel, so the audience filter
    // needs no database read on the inbound hot path.
    void this.emitToConversationAudience(
      payload.conversationId,
      payload.tenantId,
      'omni:message:new',
      payload,
      { channelId: payload.channelId },
    );
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
    void this.emitToConversationAudience(
      event.conversation?.id,
      event.tenantId,
      'omni:conversation:new',
      event.conversation,
      {
        channelId: event.conversation?.channelId,
        assignedAgentId: event.conversation?.assignedAgentId ?? null,
      },
    );
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
    void this.emitToConversationAudience(
      event.conversation?.id,
      event.tenantId,
      'omni:conversation:reopened',
      event.conversation,
      {
        channelId: event.conversation?.channelId,
        assignedAgentId: event.conversation?.assignedAgentId ?? null,
      },
    );
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
    void this.emitToConversationAudience(
      event.conversationId,
      event.tenantId,
      'omni:conversation:customer_updated',
      { conversationId: event.conversationId, customer: event.customer },
    );
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
    void this.emitToConversationAudience(
      event.conversationId,
      event.tenantId,
      'omni:message:media_cached',
      {
        conversationId: event.conversationId,
        messageId: event.messageId,
        mediaProxyUrl: event.mediaProxyUrl,
      },
    );
  }

  // Message Status (delivery receipts)

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
    status: 'delivered' | 'read' | 'failed';
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
    void this.emitToConversationAudience(
      payload.conversationId,
      payload.tenantId,
      'omni:message:status',
      {
        conversationId: payload.conversationId,
        messageIds: payload.messageIds,
        status: payload.status,
      },
    );
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
    void this.emitToConversationAudience(
      payload.conversationId,
      payload.tenantId,
      'omni:conversation:unread_reset',
      { conversationId: payload.conversationId },
    );
  }

  // Reactions (unified across all channels)

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
    void this.emitToConversationAudience(
      payload.conversationId,
      payload.tenantId,
      'omni:reaction:update',
      {
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        reactions: payload.reactions,
        trigger: payload.trigger,
      },
    );
  }

  /**
   * Socket event: agent sends an emoji reaction from the CRM UI.
   * Emits into the unified reaction pipeline so it's persisted and broadcast.
   */
  @SubscribeMessage('omni:reaction:send')
  async handleAgentReaction(
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

    // Validate reaction payload
    const validationError = validateReaction(data);
    if (validationError) {
      return { ok: false, error: validationError };
    }

    // Socket handlers bypass the HTTP guards, so the permission and the record
    // ACL are checked here — see authorizeSocketAction.
    const denied = await this.authorizeSocketAction(
      client,
      'reply',
      data.conversationId,
    );
    if (denied) return denied;

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
          createdAt: payload.createdAt ?? payload.timestamp ?? new Date(),
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
    // Presence AND format: an unvalidated id becomes a room name here and a Mongo
    // filter in the lock/claim handlers, so a malformed one either pollutes the room
    // registry or surfaces as a CastError.
    const subscribeError = validateConversationId(data);
    if (subscribeError) return { ok: false, error: subscribeError };

    // Tenant-scope the room to prevent cross-tenant realtime leaks.
    // Without this, a tenant-A socket that learns a tenant-B conversationId
    // can join its room and receive live messages/typing/lock events.
    const tenantId = client.data.tenantId;
    if (!tenantId) {
      return { ok: false, error: 'No tenant context' };
    }

    // Membership of the tenant is not permission to watch one of its
    // conversations. Tenant-scoping alone left any agent free to join any
    // conversation room in their tenant by id — the channel support pool and the
    // owner visibility scope both applied on the REST read and neither applied
    // here.
    if (!(await this.mayAccessConversation(client, data.conversationId))) {
      return { ok: false, error: 'Forbidden' };
    }

    const room = `tenant:${tenantId}:conversation:${data.conversationId}`;
    await client.join(room);
    return { ok: true, room };
  }

  /**
   * Whether this socket's principal may see this conversation — the same two axes
   * the REST layer ANDs, evaluated against the scope resolved at connect.
   */
  private async mayAccessConversation(
    client: Socket,
    conversationId: string,
  ): Promise<boolean> {
    return this.audience.mayAccess(
      client.data.scope,
      client.data.tenantId,
      conversationId,
    );
  }

  /**
   * The authorization gate for every socket command that changes something.
   *
   * Socket handlers get none of the HTTP pipeline — no `PermissionGuard`, no
   * `AclGuard`, no `@RequirePermission`. So each one checked authentication and
   * tenant membership and stopped there, and the send handlers were reachable by
   * any connected user: an agent with read-only omni access could send a message
   * to a customer on a conversation they were not allowed to open, and neither the
   * `omni_channel:reply` permission nor the record ACL applied. The REST route for
   * the same action enforced both.
   *
   * Returns an error object shaped like the handlers' own replies so a caller sees
   * a reason rather than silence.
   */
  private async authorizeSocketAction(
    client: Socket,
    permission: 'reply' | 'edit' | 'assign',
    conversationId: string,
  ): Promise<{ ok: false; error: string } | null> {
    const tenantId = client.data.tenantId as string | undefined;
    const userId = client.data.userId as string | undefined;
    if (!tenantId || !userId) return { ok: false, error: 'No tenant context' };

    const permissionKey = PERMISSION_REGISTRY.omni_channel[permission];
    const granted = client.data.scope?.permissions as Set<string> | undefined;
    if (!permissionKey || !granted?.has(permissionKey)) {
      return { ok: false, error: 'Forbidden' };
    }

    if (!(await this.mayAccessConversation(client, conversationId))) {
      return { ok: false, error: 'Forbidden' };
    }
    return null;
  }

  @SubscribeMessage('conversation.unsubscribe')
  async handleConversationUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    if (!client.data.user) return { ok: false, error: 'Unauthenticated' };
    const unsubscribeError = validateConversationId(data);
    if (unsubscribeError) return { ok: false, error: unsubscribeError };

    const tenantId = client.data.tenantId;
    if (!tenantId) {
      return { ok: false, error: 'No tenant context' };
    }

    const room = `tenant:${tenantId}:conversation:${data.conversationId}`;
    await client.leave(room);
    return { ok: true, room };
  }

  // Typing indicators

  @SubscribeMessage('omni:typing:start')
  async handleTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const user = client.data.user;
    if (!user) return;

    // Validate typing payload
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
        client.emit('omni:collision', {
          conversationId: data.conversationId,
          message: this.extractErrorMessage(error),
          lock: (error as { response?: { lock?: unknown } })?.response?.lock,
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

    // typing:start validates; stop did not, so a malformed id still broadcast.
    if (validateConversationId(data)) return;

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

  // Collision detection

  @SubscribeMessage('omni:conversation:claim')
  async handleClaim(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const user = client.data.user;
    if (!user) return { ok: false, error: 'Unauthenticated' };

    const claimError = validateConversationId(data);
    if (claimError) return { ok: false, error: claimError };

    const userId = client.data.userId ?? user.id ?? user.sub;
    const tenantId = client.data.tenantId;
    if (!tenantId) return { ok: false, error: 'No tenant context' };
    const { conversationId } = data;

    // Redis-backed claim locks instead of in-memory Map.
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

    // Atomic check-and-increment. The previous getPresence()-then-compare-
    // then-assignConversation() sequence was a check-then-act race: the same
    // agent winning the claim lock on two different conversations in quick
    // succession could pass the capacity check twice before either increment
    // landed, exceeding maxCapacity.
    const claimed = await this.presenceService.claimIfUnderCapacity(
      tenantId,
      userId,
    );
    if (!claimed) {
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

    void this.emitToConversationAudience(
      conversationId,
      tenantId,
      'omni:conversation:claimed',
      {
        conversationId,
        claimedBy: userId,
        claimedAt: new Date().toISOString(),
      },
    );

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

    const heartbeatError = validateConversationId(data);
    if (heartbeatError) return { ok: false, error: heartbeatError };

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

    const takeoverError = validateConversationId(data);
    if (takeoverError) return { ok: false, error: takeoverError };

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

  // Event listeners: status & assignment broadcasts

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

    void this.emitToConversationAudience(
      event.conversationId,
      event.tenantId,
      'omni:conversation:status_changed',
      {
        conversationId: event.conversationId,
        status: event.status,
        oldStatus: event.oldStatus,
        changedBy: event.agentId,
        reason: event.reason,
        timestamp: new Date().toISOString(),
      },
    );
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
        if (u) {
          const nameParts = [u.firstName, u.lastName]
            .filter(Boolean)
            .join(' ')
            .trim();
          agentName = (nameParts || u.email) ?? null;
        } else {
          agentName = null;
        }
      } catch {
        agentName = null;
      }
    }

    // The audience is computed from the *new* owner: after a reassignment the
    // agents who may see this conversation are the ones who can see whoever now
    // holds it. The previous owner is told directly below so their list can drop
    // a conversation that just left their scope.
    void this.emitToConversationAudience(
      event.conversationId,
      event.tenantId,
      'omni:conversation:assigned',
      {
        conversationId: event.conversationId,
        agentId: event.agentId,
        agentName,
        oldAgentId: event.oldAgentId,
        groupId: event.groupId,
        timestamp: new Date().toISOString(),
      },
      { assignedAgentId: event.agentId ?? null },
    );
    if (event.oldAgentId && event.oldAgentId !== event.agentId) {
      this.server
        .to(`agent:${event.oldAgentId}`)
        .emit('omni:conversation:assigned', {
          conversationId: event.conversationId,
          agentId: event.agentId,
          agentName,
          oldAgentId: event.oldAgentId,
          groupId: event.groupId,
          timestamp: new Date().toISOString(),
        });
    }
  }

  @OnEvent('omni.work_offer.created')
  async handleWorkOfferCreated(event: {
    tenantId: string;
    conversationId: string;
    workItemId: string;
    offerId: string;
    agentId: string;
    groupId?: string | null;
    expiresAt: Date | string;
  }) {
    if (isDedicatedWorkerProcess()) {
      await this.publishSocketEvent('socket:omni:work_offer:created', event);
      return;
    }
    this.broadcastWorkOffer(event);
  }

  private broadcastWorkOffer(event: {
    tenantId: string;
    agentId: string;
    [key: string]: any;
  }): void {
    this.server.to(`agent:${event.agentId}`).emit('omni:work_offer:new', event);
    void this.emitToConversationAudience(
      event.conversationId,
      event.tenantId,
      'omni:queue:offer_created',
      {
        conversationId: event.conversationId,
        workItemId: event.workItemId,
        offerId: event.offerId,
        agentId: event.agentId,
        expiresAt: event.expiresAt,
      },
    );
  }

  /**
   * Turn a breach into the small patch the inbox actually needs.
   *
   * The previous handler broadcast the whole clock document under
   * `omni:sla:clock_breached`, which no client ever subscribed to — so a breach
   * only became visible on the next refetch, on the screen whose entire purpose
   * is showing who is waiting. What the row renders is `slaBreached` /
   * `slaDueMetric`, so that is what goes over the wire.
   */
  @OnEvent(SlaEvents.BREACHED)
  async handleSlaBreached(event: SlaBreachedEvent) {
    // The inbox socket carries conversations. A breached ticket reaches its
    // agent through the ticket escalation channel instead.
    if (event.subjectType !== 'conversation') return;
    const patch = {
      tenantId: event.tenantId,
      conversationId: event.subjectId,
      metric: event.metric,
      breachedAt: event.breachedAt,
    };
    if (isDedicatedWorkerProcess()) {
      await this.publishSocketEvent('socket:omni:conversation:sla', patch);
      return;
    }
    this.broadcastSlaBreached(patch);
  }

  private broadcastSlaBreached(patch: {
    tenantId: string;
    conversationId: string;
    [key: string]: any;
  }): void {
    void this.emitToConversationAudience(
      patch.conversationId,
      patch.tenantId,
      'omni:conversation:sla',
      patch,
    );
  }

  @OnEvent('omni.transfer.changed')
  async handleTransferChanged(event: {
    tenantId: string;
    transferId: string;
    conversationId: string;
    type: 'cold' | 'warm' | 'consult';
    status: string;
    sourceAgentId: string;
    targetAgentId: string;
    handoffNote?: string | null;
    expiresAt: Date | string;
  }) {
    if (isDedicatedWorkerProcess()) {
      await this.publishSocketEvent('socket:omni:transfer:changed', event);
      return;
    }
    this.broadcastTransfer(event);
  }

  private broadcastTransfer(event: {
    tenantId: string;
    sourceAgentId: string;
    targetAgentId: string;
    [key: string]: any;
  }): void {
    const eventName = 'omni:transfer:changed';
    this.server.to(`agent:${event.sourceAgentId}`).emit(eventName, event);
    if (event.targetAgentId !== event.sourceAgentId) {
      this.server.to(`agent:${event.targetAgentId}`).emit(eventName, event);
    }
    void this.emitToConversationAudience(
      event.conversationId,
      event.tenantId,
      'omni:queue:transfer_changed',
      {
        transferId: event.transferId,
        conversationId: event.conversationId,
        type: event.type,
        status: event.status,
        sourceAgentId: event.sourceAgentId,
        targetAgentId: event.targetAgentId,
      },
    );
  }

  /**
   * Force-disconnect a removed/deactivated agent's live sockets.
   *
   * Without this, an already-open tab keeps sending heartbeats and can
   * resurrect the presence entry `AgentPresenceService.removePresence()` just
   * cleared, defeating the eviction.
   */
  @OnEvent('user.removed-from-tenant')
  handleUserRemovedFromTenant(event: { tenantId: string; userId: string }) {
    if (!event?.userId) return;
    try {
      this.server.in(`agent:${event.userId}`).disconnectSockets(true);
    } catch (err: any) {
      this.logger.warn(
        `Failed to force-disconnect removed user ${event.userId}: ${err.message}`,
      );
    }
  }

  @OnEvent('omni.bot.disabled')
  async handleBotDisabled(event: {
    tenantId: string;
    conversationId: string;
    reason: string;
  }) {
    await this.deliverBotState({
      ...event,
      bot: { enabled: false, status: 'ended' },
    });
  }

  @OnEvent('omni.bot.enabled')
  async handleBotEnabled(event: { tenantId: string; conversationId: string }) {
    await this.deliverBotState({
      ...event,
      bot: { enabled: true, status: 'active' },
    });
  }

  @OnEvent('omni.bot.handoff')
  async handleBotHandoffState(event: {
    tenantId: string;
    conversationId: string;
    handoff?: Record<string, any>;
  }) {
    await this.deliverBotState({
      ...event,
      bot: {
        enabled: false,
        status: 'handoff',
        handoffTarget: event.handoff?.target,
        handoffTargetId: event.handoff?.targetId,
        handoffMessage: event.handoff?.message,
      },
    });
  }

  private async deliverBotState(event: {
    tenantId: string;
    conversationId: string;
    bot: Record<string, any>;
    [key: string]: any;
  }): Promise<void> {
    const payload = { ...event, timestamp: new Date().toISOString() };
    if (isDedicatedWorkerProcess()) {
      await this.publishSocketEvent('socket:omni:bot:state', payload);
      return;
    }
    this.broadcastBotState(payload);
  }

  private broadcastBotState(event: {
    tenantId: string;
    conversationId: string;
    bot: Record<string, any>;
    [key: string]: any;
  }): void {
    const { tenantId, ...payload } = event;
    void this.emitToConversationAudience(
      event.conversationId,
      tenantId,
      'omni:conversation:bot_state',
      payload,
    );
  }

  @OnEvent('omni.conversation.lock_acquired')
  handleLockAcquired(event: any) {
    const payload = this.standardEvent('conversation.lock_acquired', event);
    this.server
      .to(`tenant:${event.tenantId}:conversation:${event.conversationId}`)
      .emit('conversation.lock_acquired', payload);
    void this.emitToConversationAudience(
      event.conversationId,
      event.tenantId,
      'omni:conversation:locked',
      {
        conversationId: event.conversationId,
        lockedBy: event.agentId,
        lockedByName: event.agentName,
        expiresAt: event.expiresAt,
      },
    );
  }

  @OnEvent('omni.conversation.lock_released')
  handleLockReleased(event: any) {
    const payload = this.standardEvent('conversation.lock_released', event);
    this.server
      .to(`tenant:${event.tenantId}:conversation:${event.conversationId}`)
      .emit('conversation.lock_released', payload);
    void this.emitToConversationAudience(
      event.conversationId,
      event.tenantId,
      'omni:conversation:unlocked',
      {
        conversationId: event.conversationId,
        agentId: event.agentId,
        releasedAt: event.releasedAt,
      },
    );
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

    void this.emitToConversationAudience(
      event.conversationId,
      event.tenantId,
      'omni:conversation:takeover',
      {
        conversationId: event.conversationId,
        previousAgentId: event.previousAgentId,
        newAgentId: event.newAgentId,
        newAgentName: event.newAgentName,
        reason: event.reason,
        occurredAt: event.occurredAt,
      },
      { assignedAgentId: event.newAgentId ?? null },
    );
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
    void this.emitToConversationAudience(
      event.conversationId,
      event.tenantId,
      'omni:conversation:note_added',
      {
        conversationId: event.conversationId,
        noteId: event.noteId,
        authorId: event.authorId,
        authorName: event.authorName,
        isPrivate: event.isPrivate,
        content: event.content,
        timestamp: new Date().toISOString(),
      },
    );
  }

  // Activity (Audit Trail) real-time broadcast

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
    void this.emitToConversationAudience(
      event.conversationId,
      event.tenantId,
      'omni:activity:new',
      { conversationId: event.conversationId, activity: event.activity },
    );
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

    void this.emitToConversationAudience(
      event.conversationId,
      event.tenantId,
      'omni:csat:received',
      payload,
    );

    // The agent who handled it is told directly: a score can land after the
    // conversation left their scope, and they are the person it is about.
    if (event.agentId) {
      this.server
        .to(`agent:${event.agentId}`)
        .emit('omni:csat:received', payload);
    }
  }

  /**
   * Authorization changed — tell the clients, and re-resolve the scopes their
   * live sockets are filtered by.
   *
   * The scope on `client.data` is a snapshot taken at connect. Without this, an
   * agent removed from a channel's support pool keeps receiving that channel's
   * messages for as long as their tab stays open, which is the whole control
   * failing on the one path where it matters most — a revocation.
   */
  @OnEvent('user.permissions.updated')
  @OnEvent('group.updated')
  @OnEvent('group.membership.updated')
  @OnEvent('tenant.permissions.updated')
  async handleAuthorizationChanged(event: {
    tenantId?: string;
    userId?: string;
  }): Promise<void> {
    if (!event?.tenantId) return;
    this.server
      .to(`tenant:${event.tenantId}`)
      .emit('authz:permissions:changed', {
        tenantId: event.tenantId,
        userId: event.userId ?? null,
      });

    await this.refreshSocketScopes(event.tenantId, event.userId);
  }

  /**
   * Re-resolve the cached scope of affected live sockets.
   *
   * Resolved once per distinct user rather than once per socket: an agent with
   * three tabs open is one authorization question.
   */
  private async refreshSocketScopes(
    tenantId: string,
    userId?: string,
  ): Promise<void> {
    const byUser = new Map<string, Socket[]>();
    for (const socket of this.server.sockets.values()) {
      if (socket.data.tenantId !== tenantId) continue;
      const socketUserId = socket.data.userId as string | undefined;
      if (!socketUserId || (userId && socketUserId !== userId)) continue;
      const existing = byUser.get(socketUserId);
      if (existing) existing.push(socket);
      else byUser.set(socketUserId, [socket]);
    }

    for (const [socketUserId, sockets] of byUser) {
      const scope = await this.resolveSocketScope(tenantId, socketUserId);
      for (const socket of sockets) socket.data.scope = scope;
    }
  }

  /** Resolve any thrown value to a human-readable error string. */
  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (error && typeof error === 'object' && 'message' in error) {
      return String((error as Record<string, unknown>).message);
    }
    return String(error);
  }
}
