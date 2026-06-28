import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { AgentPresenceService } from './agent-presence.service';
import { AgentPresence, GRACE_PERIOD_MS } from '../domain/agent-presence';
import {
  PresenceStatus,
  RoutingStatus,
  toLegacyIntent,
} from '../domain/presence-state';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { PresenceReconciliationService } from './presence-reconciliation.service';

/**
 * Socket.IO gateway for agent presence and status synchronisation.
 *
 * The backend stores the canonical 4-axis model; this gateway is the
 * anti-corruption layer translating to/from the legacy wire contract so the
 * existing frontend keeps working while the canonical model is rolled out:
 *
 *   - `routingStatus` on the wire still means CAPACITY (accept/full) for the
 *     current frontend. The new ACCEPTING/NOT_ACCEPTING switch is sent under
 *     `routingControl`, and presence under `presenceStatus` (new frontend).
 *
 * Events:
 *  - agent:status:update    (client → server)  legacy available/busy/away/offline
 *  - agent:presence:update  (client → server)  canonical presence (AVAILABLE/AWAY/BREAK/…)
 *  - agent:routing:update   (client → server)  Ready toggle (ACCEPTING/NOT_ACCEPTING)
 *  - agent:heartbeat        (client → server)
 *  - agent:list             (client → server)
 *  - agent:status:changed   (server → client)  broadcast on peer change
 *  - agent:status:sync      (server → client)  authoritative sync on connect
 */
// MED-08b: CORS origin from env
@WebSocketGateway({
  namespace: '/omni',
  cors: {
    origin: process.env.FRONTEND_DOMAIN
      ? process.env.FRONTEND_DOMAIN.split(',').map((s) => s.trim())
      : ['http://localhost:3000'],
    credentials: true,
  },
})
export class AgentPresenceGateway {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AgentPresenceGateway.name);

  /** Pending grace-period timers keyed by `tenantId:userId`. */
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly presenceService: AgentPresenceService,
    private readonly settingsService: CrmSettingsService,
    private readonly reconciliationService: PresenceReconciliationService,
  ) {}

  // ─── Client Events ──────────────────────────────────────────────────

  /** Legacy: available | busy | away | offline. */
  @SubscribeMessage('agent:status:update')
  async handleStatusUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { status: string; clientTs?: number },
  ) {
    const ctx = this.ctxOf(client);
    if (!ctx) return;

    const presence = await this.presenceService.updateIntentStatus(
      ctx.tenantId,
      ctx.userId,
      data.status as any,
      'agent_manual',
      { clientTs: data.clientTs },
    );
    this.broadcastStatus(ctx.tenantId, ctx.userId, presence);
    return { ok: true, presence: this.toWire(ctx.userId, presence) };
  }

  /** Canonical presence: AVAILABLE | AWAY | BREAK | MEETING | TRAINING. */
  @SubscribeMessage('agent:presence:update')
  async handlePresenceUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { presenceStatus: PresenceStatus; clientTs?: number },
  ) {
    const ctx = this.ctxOf(client);
    if (!ctx) return;

    const restore = await this.getRestoreAcceptingOnReturn(ctx.tenantId);
    const presence = await this.presenceService.applyPresence(
      ctx.tenantId,
      ctx.userId,
      data.presenceStatus,
      'agent_manual',
      { actor: 'agent', clientTs: data.clientTs, restoreAcceptingOnReturn: restore },
    );
    if (presence) this.broadcastStatus(ctx.tenantId, ctx.userId, presence);
    return { ok: !!presence, presence: presence ? this.toWire(ctx.userId, presence) : null };
  }

  /** Ready toggle: ACCEPTING | NOT_ACCEPTING. */
  @SubscribeMessage('agent:routing:update')
  async handleRoutingUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { routingStatus: RoutingStatus; clientTs?: number },
  ) {
    const ctx = this.ctxOf(client);
    if (!ctx) return;

    const presence = await this.presenceService.setRoutingControl(
      ctx.tenantId,
      ctx.userId,
      data.routingStatus,
      'agent_manual',
      { clientTs: data.clientTs },
    );
    if (presence) this.broadcastStatus(ctx.tenantId, ctx.userId, presence);
    return { ok: !!presence, presence: presence ? this.toWire(ctx.userId, presence) : null };
  }

  @SubscribeMessage('agent:heartbeat')
  async handleHeartbeat(@ConnectedSocket() client: Socket) {
    const ctx = this.ctxOf(client);
    if (!ctx) return;
    await this.presenceService.heartbeat(ctx.tenantId, ctx.userId);
    return { ok: true };
  }

  @SubscribeMessage('agent:list')
  async handleListAgents(@ConnectedSocket() client: Socket) {
    const ctx = this.ctxOf(client);
    if (!ctx) return;
    const agents = await this.presenceService.getAllAgents(ctx.tenantId);
    return { ok: true, agents: agents.map((a) => this.toWire(a.userId, a)) };
  }

  // ─── Connection Lifecycle (called by OmniGateway) ─────────────────

  async onAgentConnected(
    tenantId: string,
    userId: string,
    socketId: string,
    attributes?: { skills?: string[]; maxCapacity?: number },
  ): Promise<void> {
    this.cancelGraceTimer(tenantId, userId);

    const autoAvailable = await this.getAutoAvailableOnConnect(tenantId);

    const { presence, isFreshSession } =
      await this.presenceService.addConnection(
        tenantId,
        userId,
        socketId,
        autoAvailable,
        attributes,
      );

    this.broadcastStatus(tenantId, userId, presence);

    // Authoritative sync directly to the connecting socket (page-reload fix).
    this.server.to(socketId).emit('agent:status:sync', this.toWire(userId, presence));
    this.logger.debug(
      `Sent agent:status:sync to ${userId} (presence=${presence.presenceStatus})`,
    );

    this.logger.log(
      `Agent ${userId} connected (fresh=${isFreshSession}, ` +
        `presence=${presence.presenceStatus}, connections=${presence.connections.length})`,
    );

    // P0 self-heal: reconcile Redis counter vs MongoDB on every connect.
    this.reconciliationService.reconcileAgent(tenantId, userId).catch((err) =>
      this.logger.error(
        `Reconcile failed on connect for agent ${userId}: ${err.message}`,
      ),
    );
  }

  async onAgentDisconnected(
    tenantId: string,
    userId: string,
    socketId: string,
  ): Promise<{ allDisconnected: boolean }> {
    const { presence, allDisconnected } =
      await this.presenceService.removeConnection(tenantId, userId, socketId);

    if (!presence) {
      return { allDisconnected: true };
    }

    if (allDisconnected) {
      this.broadcastStatus(tenantId, userId, presence);
      void this.startGraceTimer(tenantId, userId);
      this.logger.warn(
        `Agent ${userId} all connections lost — grace period started`,
      );
    } else {
      this.logger.log(
        `Agent ${userId} socket ${socketId} disconnected, ` +
          `${presence.connections.length} connection(s) remaining`,
      );
    }

    return { allDisconnected };
  }

  // ─── Grace Period Management ────────────────────────────────────────

  private async startGraceTimer(tenantId: string, userId: string): Promise<void> {
    const timerKey = `${tenantId}:${userId}`;
    this.cancelGraceTimer(tenantId, userId);

    // Phase 2.5: read grace period from tenant settings, fallback to hardcoded constant
    let gracePeriodMs = GRACE_PERIOD_MS;
    try {
      const cfg = await this.settingsService.getSetting('omni_presence', tenantId);
      const graceSec = (cfg as any)?.gracePeriodSeconds;
      if (typeof graceSec === 'number' && graceSec > 0) {
        gracePeriodMs = graceSec * 1000;
      }
    } catch {
      // fallback to default
    }

    const timer = setTimeout(async () => {
      this.graceTimers.delete(timerKey);
      await this.handleGraceExpired(tenantId, userId);
    }, gracePeriodMs);
    this.graceTimers.set(timerKey, timer);
  }

  private cancelGraceTimer(tenantId: string, userId: string): void {
    const timerKey = `${tenantId}:${userId}`;
    const existing = this.graceTimers.get(timerKey);
    if (existing) {
      clearTimeout(existing);
      this.graceTimers.delete(timerKey);
      this.logger.log(
        `Grace period timer cancelled for agent ${userId} (reconnected)`,
      );
    }
  }

  private async handleGraceExpired(
    tenantId: string,
    userId: string,
  ): Promise<void> {
    this.logger.warn(
      `Grace period expired for agent ${userId} — forcing offline`,
    );
    const presence = await this.presenceService.handleGracePeriodExpired(
      tenantId,
      userId,
    );
    if (presence) {
      this.broadcastStatus(tenantId, userId, presence);
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private ctxOf(
    client: Socket,
  ): { tenantId: string; userId: string } | null {
    const user = client.data.user;
    if (!user) return null;
    const tenantId = client.data.tenantId;
    const userId = client.data.userId;
    if (!tenantId || !userId) return null;
    return { tenantId, userId };
  }

  /**
   * Project a canonical presence record onto the wire DTO. Keeps the legacy
   * fields the current frontend reads (`status`, `intentStatus`,
   * `connectionStatus`, `routingStatus`=capacity) AND adds the canonical fields
   * (`presenceStatus`, `routingControl`, `workStatus`) for the new frontend.
   */
  private toWire(userId: string, presence: AgentPresence) {
    return {
      userId,
      // legacy contract (current frontend)
      status: presence.status,
      intentStatus: toLegacyIntent(presence.presenceStatus, presence.routingStatus),
      connectionStatus: presence.connectionStatus.toLowerCase(),
      // legacy `routingStatus` means CAPACITY for the current frontend: accept | full
      routingStatus: presence.capacityStatus === 'FULL' ? 'full' : 'accept',
      activeConversations: presence.activeConversations,
      maxCapacity: presence.maxCapacity,
      // canonical contract (new frontend)
      presenceStatus: presence.presenceStatus,
      routingControl: presence.routingStatus,
      workStatus: presence.workStatus,
      capacityStatus: presence.capacityStatus,
    };
  }

  private broadcastStatus(
    tenantId: string,
    userId: string,
    presence: AgentPresence,
  ): void {
    this.server
      .to(`tenant:${tenantId}`)
      .emit('agent:status:changed', this.toWire(userId, presence));
  }

  private async getAutoAvailableOnConnect(tenantId: string): Promise<boolean> {
    try {
      const config = await this.settingsService.getSetting(
        'omni_routing',
        tenantId,
      );
      return (config as any)?.autoAvailableOnConnect ?? false;
    } catch {
      return false;
    }
  }

  private async getRestoreAcceptingOnReturn(tenantId: string): Promise<boolean> {
    try {
      const config = await this.settingsService.getSetting(
        'omni_presence',
        tenantId,
      );
      return (config as any)?.restoreAcceptingOnReturn ?? false;
    } catch {
      return false;
    }
  }
}
