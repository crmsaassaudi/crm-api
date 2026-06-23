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
import {
  AgentIntentStatus,
  AgentStatus,
  GRACE_PERIOD_MS,
} from '../domain/agent-presence';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { PresenceReconciliationService } from './presence-reconciliation.service';

/**
 * Socket.IO gateway for agent presence and status synchronisation.
 *
 * Responsibilities:
 *   - Relay agent intent status changes (UI → Redis → broadcast)
 *   - Periodic heartbeat to keep agent online (TTL refresh)
 *   - Multi-tab connection tracking (addConnection/removeConnection)
 *   - Grace period management for network disconnections
 *   - Hybrid auto-available on connect (per-tenant setting)
 *
 * Events:
 *  - agent:status:update   (client → server)  Agent changes their own status
 *  - agent:heartbeat       (client → server)  Periodic heartbeat to stay online
 *  - agent:status:changed  (server → client)  Broadcast when a peer's status changes
 *  - agent:list            (client → server)  Request all agents for the tenant
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

  /**
   * In-memory map of pending grace period timers.
   * Key: `tenantId:userId` → setTimeout handle
   * Cleared when agent reconnects before grace period expires.
   */
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly presenceService: AgentPresenceService,
    private readonly settingsService: CrmSettingsService,
    private readonly reconciliationService: PresenceReconciliationService,
  ) {}

  // ─── Client Events ──────────────────────────────────────────────────

  @SubscribeMessage('agent:status:update')
  async handleStatusUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { status: AgentStatus },
  ) {
    const user = client.data.user;
    if (!user) return;

    const tenantId = client.data.tenantId;
    const userId = client.data.userId;
    if (!tenantId || !userId) return;

    const intentStatus = data.status as AgentIntentStatus;

    const presence = await this.presenceService.updateIntentStatus(
      tenantId,
      userId,
      intentStatus,
      'agent_manual',
    );

    // Broadcast enriched payload to the entire tenant namespace
    this.broadcastStatus(tenantId, userId, presence);

    this.logger.log(`Agent ${userId} → ${intentStatus} (manual)`);
    return { ok: true, presence };
  }

  @SubscribeMessage('agent:heartbeat')
  async handleHeartbeat(@ConnectedSocket() client: Socket) {
    const user = client.data.user;
    if (!user) return;

    const tenantId = client.data.tenantId;
    const userId = client.data.userId;
    if (!tenantId || !userId) return;

    await this.presenceService.heartbeat(tenantId, userId);
    return { ok: true };
  }

  @SubscribeMessage('agent:list')
  async handleListAgents(@ConnectedSocket() client: Socket) {
    const user = client.data.user;
    if (!user) return;

    const tenantId = client.data.tenantId;
    if (!tenantId) return;
    const agents = await this.presenceService.getAllAgents(tenantId);

    return { ok: true, agents };
  }

  // ─── Connection Lifecycle (called by OmniGateway) ─────────────────

  /**
   * Called when a client socket connects.
   *
   * Implements the hybrid auto-available logic:
   *   - Fresh session + autoAvailableOnConnect=true  → available
   *   - Fresh session + autoAvailableOnConnect=false → offline (agent must click)
   *   - Reconnect within grace period               → restore previous intent
   */
  async onAgentConnected(
    tenantId: string,
    userId: string,
    socketId: string,
  ): Promise<void> {
    // Cancel any pending grace period timer for this agent
    this.cancelGraceTimer(tenantId, userId);

    // Resolve tenant setting for auto-available behavior
    const autoAvailable = await this.getAutoAvailableOnConnect(tenantId);

    const { presence, isFreshSession } =
      await this.presenceService.addConnection(
        tenantId,
        userId,
        socketId,
        autoAvailable,
      );

    // Broadcast current status to all agents in tenant
    this.broadcastStatus(tenantId, userId, presence);

    // Emit authoritative status directly to the connecting socket
    // so the frontend can sync its local store with backend truth
    // (critical for page reload — frontend store resets to defaults)
    this.server.to(socketId).emit('agent:status:sync', {
      status: presence.status,
      intentStatus: presence.intentStatus,
      connectionStatus: presence.connectionStatus,
      routingStatus: presence.routingStatus,
      activeConversations: presence.activeConversations,
      maxCapacity: presence.maxCapacity,
    });
    this.logger.debug(
      `Sent agent:status:sync to ${userId} (intent=${presence.intentStatus})`,
    );

    this.logger.log(
      `Agent ${userId} connected (fresh=${isFreshSession}, ` +
        `intent=${presence.intentStatus}, ` +
        `connections=${presence.connections.length})`,
    );

    // P0 fix: reconcile Redis activeConversations counter against MongoDB on
    // every connect event. This is the primary self-healing trigger — if Redis
    // was flushed while the agent was offline, their counter is wrong and would
    // block new assignments. Fire-and-forget; failures are logged internally.
    this.reconciliationService.reconcileAgent(tenantId, userId).catch((err) =>
      this.logger.error(
        `Reconcile failed on connect for agent ${userId}: ${err.message}`,
      ),
    );
  }

  /**
   * Called when a single socket disconnects.
   *
   * Does NOT immediately mark the agent as offline.
   * Instead:
   *   1. Removes the socketId from connections[]
   *   2. If ALL connections are gone → starts grace period timer
   *   3. Grace period expired → force offline + trigger fallback
   */
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
      // All tabs/devices lost → broadcast disconnected state
      this.broadcastStatus(tenantId, userId, presence);

      // Start grace period timer
      this.startGraceTimer(tenantId, userId);

      this.logger.warn(
        `Agent ${userId} all connections lost — grace period started (${GRACE_PERIOD_MS / 1000}s)`,
      );
    } else {
      // Still have other connections — no status change needed
      this.logger.log(
        `Agent ${userId} socket ${socketId} disconnected, ` +
          `${presence.connections.length} connection(s) remaining`,
      );
    }

    return { allDisconnected };
  }

  // ─── Grace Period Management ────────────────────────────────────────

  /**
   * Start a grace period timer for an agent.
   * If they don't reconnect within GRACE_PERIOD_MS, force offline.
   */
  private startGraceTimer(tenantId: string, userId: string): void {
    const timerKey = `${tenantId}:${userId}`;

    // Cancel any existing timer (shouldn't happen, but be safe)
    this.cancelGraceTimer(tenantId, userId);

    const timer = setTimeout(async () => {
      this.graceTimers.delete(timerKey);
      await this.handleGraceExpired(tenantId, userId);
    }, GRACE_PERIOD_MS);

    this.graceTimers.set(timerKey, timer);
  }

  /**
   * Cancel a pending grace period timer (agent reconnected in time).
   */
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

  /**
   * Called when the grace period expires without reconnection.
   * Forces the agent offline and broadcasts the change.
   */
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

  /**
   * Broadcast enriched status payload with all 3 axes.
   * Backward-compatible: still includes the computed `status` field.
   */
  private broadcastStatus(
    tenantId: string,
    userId: string,
    presence: {
      status: AgentStatus;
      intentStatus: AgentIntentStatus;
      connectionStatus: string;
      routingStatus: string;
      activeConversations: number;
      maxCapacity: number;
    },
  ): void {
    this.server.to(`tenant:${tenantId}`).emit('agent:status:changed', {
      userId,
      status: presence.status, // backward compat
      intentStatus: presence.intentStatus,
      connectionStatus: presence.connectionStatus,
      routingStatus: presence.routingStatus,
      activeConversations: presence.activeConversations,
      maxCapacity: presence.maxCapacity,
    });
  }

  /**
   * Get the auto-available-on-connect setting for a tenant.
   * Defaults to false (manual activation).
   */
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
}
