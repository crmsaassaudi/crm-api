import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import {
  AgentPresence,
  AgentIntentStatus,
  AgentConnectionStatus,
  AgentStatus,
  StatusTransitionTrigger,
  agentPresenceKey,
  computeDisplayStatus,
  computeRoutingStatus,
  isEligibleForRouting,
  HEARTBEAT_TTL_SECONDS,
  DEFAULT_MAX_CAPACITY,
} from '../domain/agent-presence';

// ────────────────────────────────────────────────────────────────────────
// Lua Scripts for atomic Redis operations
// ────────────────────────────────────────────────────────────────────────

/**
 * Atomic assign: increment activeConversations ONLY if under capacity.
 *
 * KEYS[1] = presence key
 * ARGV[1] = TTL seconds
 *
 * Returns 1 if assigned, 0 if at capacity or key missing.
 * Also updates routingStatus and recomputes display status.
 */
const LUA_ATOMIC_ASSIGN = `
local key = KEYS[1]
local ttl = tonumber(ARGV[1])
local raw = redis.call('GET', key)
if not raw then return 0 end

local data = cjson.decode(raw)
if data.activeConversations >= data.maxCapacity then return 0 end

data.activeConversations = data.activeConversations + 1

if data.activeConversations >= data.maxCapacity then
  data.routingStatus = 'full'
else
  data.routingStatus = 'accept'
end

-- Recompute display status
if data.intentStatus == 'offline' or data.connectionStatus == 'disconnected' then
  data.status = 'offline'
else
  data.status = data.intentStatus
end

redis.call('SETEX', key, ttl, cjson.encode(data))
return 1
`;

/**
 * Atomic release: decrement activeConversations, update routingStatus.
 * NEVER touches intentStatus.
 *
 * KEYS[1] = presence key
 * ARGV[1] = TTL seconds
 *
 * Returns the updated presence JSON, or nil if key missing.
 */
const LUA_ATOMIC_RELEASE = `
local key = KEYS[1]
local ttl = tonumber(ARGV[1])
local raw = redis.call('GET', key)
if not raw then return nil end

local data = cjson.decode(raw)
data.activeConversations = math.max(0, data.activeConversations - 1)

if data.activeConversations < data.maxCapacity then
  data.routingStatus = 'accept'
else
  data.routingStatus = 'full'
end

-- Recompute display status (NEVER change intentStatus here)
if data.intentStatus == 'offline' or data.connectionStatus == 'disconnected' then
  data.status = 'offline'
else
  data.status = data.intentStatus
end

redis.call('SETEX', key, ttl, cjson.encode(data))
return cjson.encode(data)
`;

/**
 * Callback invoked when an agent's intentStatus changes.
 * Used to wire in audit logging without circular dependencies.
 */
export type StatusTransitionCallback = (
  tenantId: string,
  agentId: string,
  fromStatus: AgentIntentStatus,
  toStatus: AgentIntentStatus,
  trigger: StatusTransitionTrigger,
) => void | Promise<void>;

/**
 * Manages agent presence and capacity in Redis.
 *
 * Architecture:
 *   - 3-axis state model: Intent × Connection × Routing
 *   - Atomic Lua scripts for capacity operations (no race conditions)
 *   - Multi-tab connection tracking via connections[] array
 *   - Grace period handled by the gateway layer
 *
 * Intent Status:  set by the agent (available, busy, away, offline)
 * Connection Status: set by socket connect/disconnect events
 * Routing Status: computed from activeConversations vs maxCapacity
 * Display Status: deterministically derived from Intent + Connection
 */
@Injectable()
export class AgentPresenceService {
  private readonly logger = new Logger(AgentPresenceService.name);

  /** Optional callback for audit logging of status transitions */
  private statusTransitionCallback?: StatusTransitionCallback;

  constructor(private readonly redis: RedisService) {}

  /**
   * Register a callback to be invoked on every intentStatus transition.
   * Called by AgentStatusAuditService during module init.
   */
  setStatusTransitionCallback(cb: StatusTransitionCallback): void {
    this.statusTransitionCallback = cb;
  }

  // ────────────────────────────────────────────────────────────────────
  // Intent Status (human-controlled)
  // ────────────────────────────────────────────────────────────────────

  /**
   * Set the agent's intent status (human decision).
   *
   * This ONLY changes intentStatus. It never touches connectionStatus
   * or routingStatus. The display status is recomputed after.
   */
  async updateIntentStatus(
    tenantId: string,
    userId: string,
    intentStatus: AgentIntentStatus,
    trigger: StatusTransitionTrigger = 'agent_manual',
  ): Promise<AgentPresence> {
    const key = agentPresenceKey(tenantId, userId);
    const client = this.redis.getClient();
    const existing = await this.getPresence(tenantId, userId);

    const oldIntent = existing?.intentStatus ?? 'offline';

    const presence: AgentPresence = {
      userId,
      tenantId,
      intentStatus,
      connectionStatus: existing?.connectionStatus ?? 'disconnected',
      routingStatus: computeRoutingStatus(
        existing?.activeConversations ?? 0,
        existing?.maxCapacity ?? DEFAULT_MAX_CAPACITY,
      ),
      status: computeDisplayStatus(
        intentStatus,
        existing?.connectionStatus ?? 'disconnected',
      ),
      activeConversations: existing?.activeConversations ?? 0,
      maxCapacity: existing?.maxCapacity ?? DEFAULT_MAX_CAPACITY,
      connections: existing?.connections ?? [],
      lastHeartbeat: new Date(),
      disconnectedAt: existing?.disconnectedAt,
      socketId: existing?.socketId,
    };

    await client.setex(key, HEARTBEAT_TTL_SECONDS, JSON.stringify(presence));

    this.logger.log(
      `Agent ${userId} intentStatus → ${intentStatus} (trigger: ${trigger})`,
    );

    // Fire audit callback if status actually changed
    if (oldIntent !== intentStatus && this.statusTransitionCallback) {
      try {
        await this.statusTransitionCallback(
          tenantId,
          userId,
          oldIntent,
          intentStatus,
          trigger,
        );
      } catch (err) {
        this.logger.error(`Status transition callback failed: ${err.message}`);
      }
    }

    return presence;
  }

  /**
   * @deprecated Use updateIntentStatus() instead.
   * Kept for backward compatibility during migration.
   */
  async updateStatus(
    tenantId: string,
    userId: string,
    status: AgentStatus,
    socketId?: string,
  ): Promise<AgentPresence> {
    // Map old single-status to the new intent model
    const intentStatus = status as AgentIntentStatus;
    const result = await this.updateIntentStatus(
      tenantId,
      userId,
      intentStatus,
      'agent_manual',
    );

    // Preserve socketId for backward compat
    if (socketId) {
      const key = agentPresenceKey(tenantId, userId);
      const client = this.redis.getClient();
      result.socketId = socketId;
      if (!result.connections.includes(socketId)) {
        result.connections.push(socketId);
      }
      await client.setex(key, HEARTBEAT_TTL_SECONDS, JSON.stringify(result));
    }

    return result;
  }

  // ────────────────────────────────────────────────────────────────────
  // Connection Tracking (system-controlled, multi-tab)
  // ────────────────────────────────────────────────────────────────────

  /**
   * Register a new socket connection for an agent.
   * Called when a socket connects (each tab = one connection).
   *
   * - Adds socketId to connections[]
   * - Sets connectionStatus = 'connected'
   * - Clears disconnectedAt
   * - If fresh session (no existing presence), sets intentStatus based on tenant config
   *
   * @returns The updated presence and whether this was a fresh session
   */
  async addConnection(
    tenantId: string,
    userId: string,
    socketId: string,
    autoAvailableOnConnect: boolean = false,
  ): Promise<{ presence: AgentPresence; isFreshSession: boolean }> {
    const key = agentPresenceKey(tenantId, userId);
    const client = this.redis.getClient();
    const existing = await this.getPresence(tenantId, userId);

    const isFreshSession = !existing;
    let intentStatus: AgentIntentStatus;
    let trigger: StatusTransitionTrigger;

    if (isFreshSession) {
      // No prior presence → fresh session
      intentStatus = autoAvailableOnConnect ? 'available' : 'offline';
      trigger = autoAvailableOnConnect
        ? 'system_auto_available'
        : 'system_connect';
    } else if (existing.connectionStatus === 'disconnected') {
      // Reconnect within grace period → restore previous intent
      intentStatus = existing.intentStatus;
      trigger = 'system_reconnect';
      this.logger.log(
        `Agent ${userId} reconnected within grace period → restoring intentStatus: ${intentStatus}`,
      );
    } else {
      // Additional tab/device → keep current intent
      intentStatus = existing.intentStatus;
      trigger = 'system_connect';
    }

    const connections = existing?.connections
      ? [...existing.connections.filter((id) => id !== socketId), socketId]
      : [socketId];

    const presence: AgentPresence = {
      userId,
      tenantId,
      intentStatus,
      connectionStatus: 'connected',
      routingStatus: computeRoutingStatus(
        existing?.activeConversations ?? 0,
        existing?.maxCapacity ?? DEFAULT_MAX_CAPACITY,
      ),
      status: computeDisplayStatus(intentStatus, 'connected'),
      activeConversations: existing?.activeConversations ?? 0,
      maxCapacity: existing?.maxCapacity ?? DEFAULT_MAX_CAPACITY,
      connections,
      lastHeartbeat: new Date(),
      disconnectedAt: undefined,
      socketId,
    };

    await client.setex(key, HEARTBEAT_TTL_SECONDS, JSON.stringify(presence));

    this.logger.log(
      `Agent ${userId} socket ${socketId} connected (${connections.length} total connections)`,
    );

    // Fire audit callback for fresh session intent assignment
    if (isFreshSession && this.statusTransitionCallback) {
      try {
        await this.statusTransitionCallback(
          tenantId,
          userId,
          'offline',
          intentStatus,
          trigger,
        );
      } catch (err) {
        this.logger.error(`Status transition callback failed: ${err.message}`);
      }
    }

    // Fire audit callback for reconnect (connection restored)
    if (
      !isFreshSession &&
      existing?.connectionStatus === 'disconnected' &&
      this.statusTransitionCallback
    ) {
      try {
        await this.statusTransitionCallback(
          tenantId,
          userId,
          existing.intentStatus, // "from" is the same because intent didn't change
          intentStatus,
          trigger,
        );
      } catch (err) {
        this.logger.error(`Status transition callback failed: ${err.message}`);
      }
    }

    return { presence, isFreshSession };
  }

  /**
   * Remove a socket connection for an agent.
   * Called when a single socket disconnects (tab close, network drop).
   *
   * - Removes socketId from connections[]
   * - If connections[] is now empty → sets connectionStatus = 'disconnected'
   *   and records disconnectedAt for grace period tracking
   * - Does NOT change intentStatus — the grace period timer handles that
   *
   * @returns `allDisconnected` = true if this was the last connection
   */
  async removeConnection(
    tenantId: string,
    userId: string,
    socketId: string,
  ): Promise<{
    presence: AgentPresence | null;
    allDisconnected: boolean;
  }> {
    const key = agentPresenceKey(tenantId, userId);
    const client = this.redis.getClient();
    const existing = await this.getPresence(tenantId, userId);

    if (!existing) {
      return { presence: null, allDisconnected: true };
    }

    const connections = existing.connections.filter((id) => id !== socketId);
    const allDisconnected = connections.length === 0;

    const connectionStatus: AgentConnectionStatus = allDisconnected
      ? 'disconnected'
      : 'connected';

    const presence: AgentPresence = {
      ...existing,
      connections,
      connectionStatus,
      status: computeDisplayStatus(existing.intentStatus, connectionStatus),
      disconnectedAt: allDisconnected ? new Date() : existing.disconnectedAt,
      lastHeartbeat: new Date(),
    };

    // Remove deprecated socketId if the disconnected socket was the primary
    if (existing.socketId === socketId) {
      presence.socketId = connections[0]; // next available, or undefined
    }

    await client.setex(key, HEARTBEAT_TTL_SECONDS, JSON.stringify(presence));

    this.logger.log(
      `Agent ${userId} socket ${socketId} disconnected ` +
        `(${connections.length} remaining). ` +
        `allDisconnected=${allDisconnected}`,
    );

    return { presence, allDisconnected };
  }

  // ────────────────────────────────────────────────────────────────────
  // Grace Period Expiry
  // ────────────────────────────────────────────────────────────────────

  /**
   * Called when the grace period expires and the agent hasn't reconnected.
   * Forces intentStatus → 'offline' and triggers audit log.
   */
  async handleGracePeriodExpired(
    tenantId: string,
    userId: string,
  ): Promise<AgentPresence | null> {
    const existing = await this.getPresence(tenantId, userId);
    if (!existing) return null;

    // Guard: if agent reconnected in the meantime, skip
    if (existing.connectionStatus === 'connected') {
      this.logger.debug(
        `Grace period expired for agent ${userId} but they're already reconnected — skipping`,
      );
      return existing;
    }

    return this.updateIntentStatus(
      tenantId,
      userId,
      'offline',
      'system_grace_expired',
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Heartbeat
  // ────────────────────────────────────────────────────────────────────

  /**
   * Refresh heartbeat TTL without changing any status.
   * Called periodically by the frontend (every 30s).
   *
   * If the key doesn't exist, we do NOT re-register the agent as offline.
   * The grace period + fallback service handles that case properly.
   */
  async heartbeat(tenantId: string, userId: string): Promise<void> {
    const key = agentPresenceKey(tenantId, userId);
    const client = this.redis.getClient();

    const raw = await client.get(key);
    if (raw) {
      const presence: AgentPresence = JSON.parse(raw);
      presence.lastHeartbeat = new Date();
      await client.setex(key, HEARTBEAT_TTL_SECONDS, JSON.stringify(presence));
    } else {
      // Key expired or never existed — do NOT auto-register.
      // The frontend will re-establish via socket connect → addConnection().
      this.logger.warn(
        `Heartbeat for agent ${userId} but no presence key — ignoring ` +
          `(agent will re-register on reconnect)`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Capacity Operations (atomic via Lua scripts)
  // ────────────────────────────────────────────────────────────────────

  /**
   * Atomically increment the active conversation count for an agent.
   * Returns false if the agent is at capacity or not found.
   *
   * Uses a Lua script to guarantee atomicity — no race conditions
   * even with concurrent requests across multiple server nodes.
   */
  async assignConversation(tenantId: string, userId: string): Promise<boolean> {
    const key = agentPresenceKey(tenantId, userId);
    const client = this.redis.getClient();

    const result = await client.eval(
      LUA_ATOMIC_ASSIGN,
      1,
      key,
      HEARTBEAT_TTL_SECONDS.toString(),
    );

    const assigned = result === 1;

    if (assigned) {
      const presence = await this.getPresence(tenantId, userId);
      this.logger.log(
        `Assigned conversation to agent ${userId} ` +
          `(${presence?.activeConversations}/${presence?.maxCapacity}) ` +
          `[routing: ${presence?.routingStatus}]`,
      );
    }

    return assigned;
  }

  /**
   * Atomically decrement the active conversation count for an agent.
   *
   * CRITICAL: This NEVER changes intentStatus. If the agent manually
   * set 'busy', they stay 'busy'. Only routingStatus changes
   * (full → accept when capacity frees up).
   */
  async releaseConversation(tenantId: string, userId: string): Promise<void> {
    const key = agentPresenceKey(tenantId, userId);
    const client = this.redis.getClient();

    const result = await client.eval(
      LUA_ATOMIC_RELEASE,
      1,
      key,
      HEARTBEAT_TTL_SECONDS.toString(),
    );

    if (result) {
      const updated: AgentPresence = JSON.parse(result as string);
      this.logger.log(
        `Released conversation for agent ${userId} ` +
          `(${updated.activeConversations}/${updated.maxCapacity}) ` +
          `[intent: ${updated.intentStatus}, routing: ${updated.routingStatus}]`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Queries
  // ────────────────────────────────────────────────────────────────────

  /**
   * Get a single agent's presence.
   */
  async getPresence(
    tenantId: string,
    userId: string,
  ): Promise<AgentPresence | null> {
    const key = agentPresenceKey(tenantId, userId);
    const client = this.redis.getClient();
    const raw = await client.get(key);
    return raw ? JSON.parse(raw) : null;
  }

  /**
   * Get all agents for a tenant (any status).
   */
  async getAllAgents(tenantId: string): Promise<AgentPresence[]> {
    const client = this.redis.getClient();
    const pattern = `omni:agent:presence:${tenantId}:*`;
    const keys = await client.keys(pattern);

    if (keys.length === 0) return [];

    const pipeline = client.pipeline();
    keys.forEach((k) => pipeline.get(k));
    const results = await pipeline.exec();

    const agents: AgentPresence[] = [];
    for (const result of results ?? []) {
      const [err, raw] = result;
      if (!err && raw) {
        agents.push(JSON.parse(raw as string));
      }
    }

    return agents;
  }

  /**
   * Get all agents eligible for auto-assignment routing.
   *
   * An agent is eligible when ALL three conditions are met:
   *   1. intentStatus === 'available'
   *   2. connectionStatus === 'connected'
   *   3. routingStatus === 'accept' (not at capacity)
   */
  async getAvailableAgents(tenantId: string): Promise<AgentPresence[]> {
    const allAgents = await this.getAllAgents(tenantId);
    return allAgents.filter(isEligibleForRouting);
  }

  /**
   * Get user IDs of agents eligible for routing.
   * Used by AssignmentService for auto-assignment.
   */
  async getOnlineAgents(tenantId: string): Promise<string[]> {
    const available = await this.getAvailableAgents(tenantId);
    return available.map((a) => a.userId);
  }

  // ────────────────────────────────────────────────────────────────────
  // Administration
  // ────────────────────────────────────────────────────────────────────

  /**
   * Remove an agent's presence entirely (e.g. on explicit logout).
   */
  async removePresence(tenantId: string, userId: string): Promise<void> {
    const key = agentPresenceKey(tenantId, userId);
    const client = this.redis.getClient();
    await client.del(key);
    this.logger.log(`Agent ${userId} removed from presence`);
  }

  /**
   * Update the max capacity for an agent in their Redis presence record.
   * Recomputes routingStatus after changing capacity.
   */
  async updateMaxCapacity(
    tenantId: string,
    userId: string,
    maxCapacity: number,
  ): Promise<void> {
    const presence = await this.getPresence(tenantId, userId);
    if (!presence) return;

    presence.maxCapacity = maxCapacity;
    presence.routingStatus = computeRoutingStatus(
      presence.activeConversations,
      maxCapacity,
    );
    presence.status = computeDisplayStatus(
      presence.intentStatus,
      presence.connectionStatus,
    );

    const key = agentPresenceKey(tenantId, userId);
    const client = this.redis.getClient();
    await client.setex(key, HEARTBEAT_TTL_SECONDS, JSON.stringify(presence));

    this.logger.log(
      `Updated max capacity for agent ${userId} to ${maxCapacity} ` +
        `[routing: ${presence.routingStatus}]`,
    );
  }

  /**
   * Get the configured max capacity for an agent.
   */
  async getAgentCapacity(tenantId: string, userId: string): Promise<number> {
    const presence = await this.getPresence(tenantId, userId);
    return presence?.maxCapacity ?? DEFAULT_MAX_CAPACITY;
  }
}
