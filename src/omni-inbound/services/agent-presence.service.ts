import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
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
  tenantAgentLoadKey,
  tenantPresenceHashKey,
} from '../domain/agent-presence';

// ────────────────────────────────────────────────────────────────────────
// Lua Scripts for atomic Redis operations
// ────────────────────────────────────────────────────────────────────────

/**
 * Atomic release: decrement activeConversations, update routingStatus.
 * NEVER touches intentStatus.
 *
 * KEYS[1] = tenant presence hash
 * KEYS[2] = tenant load ZSET
 * ARGV[1] = agent id
 *
 * Returns the updated presence JSON, or nil if key missing.
 */
const LUA_ATOMIC_RELEASE = `
local presenceHash = KEYS[1]
local loadZset = KEYS[2]
local agentId = ARGV[1]
local raw = redis.call('HGET', presenceHash, agentId)
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

redis.call('HSET', presenceHash, agentId, cjson.encode(data))
redis.call('ZADD', loadZset, data.activeConversations, agentId)
return cjson.encode(data)
`;

/**
 * Reserve one eligible agent from a candidate list.
 *
 * KEYS[1] = tenant presence hash
 * KEYS[2] = tenant load ZSET
 * ARGV[1] = number of candidates
 * ARGV[2..n] = candidate agent ids
 * ARGV[n+1]  = current Unix timestamp in ms  (for freshness check)
 * ARGV[n+2]  = heartbeat TTL in ms           (HEARTBEAT_TTL_SECONDS * 1000)
 *
 * Returns the selected agent id, or nil if no candidate has capacity.
 *
 * F-01 fix: checks lastHeartbeatMs inside the JSON to reject stale Hash/ZSET
 * entries that were not cleaned up by TTL expiry on the individual key.
 */
const LUA_RESERVE_FROM_CANDIDATES = `
local presenceHash = KEYS[1]
local loadZset = KEYS[2]
local candidateCount = tonumber(ARGV[1])
local nowMs = tonumber(ARGV[candidateCount + 2])
local heartbeatTtlMs = tonumber(ARGV[candidateCount + 3])
local bestAgent = nil
local bestLoad = nil

for i = 1, candidateCount do
  local agentId = ARGV[i + 1]
  local raw = redis.call('HGET', presenceHash, agentId)
  if raw then
    local data = cjson.decode(raw)
    local active = tonumber(data.activeConversations or 0)
    local capacity = tonumber(data.maxCapacity or 0)
    -- F-01: freshness guard — reject entries whose heartbeat has expired.
    local heartbeatMs = tonumber(data.lastHeartbeatMs or 0)
    local isStale = nowMs - heartbeatMs > heartbeatTtlMs
    if not isStale
      and data.intentStatus == 'available'
      and data.connectionStatus == 'connected'
      and capacity > 0
      and active < capacity then
      local score = redis.call('ZSCORE', loadZset, agentId)
      local load = tonumber(score or active)
      if bestLoad == nil or load < bestLoad then
        bestLoad = load
        bestAgent = agentId
      end
    end
  end
end

if not bestAgent then return nil end

local raw = redis.call('HGET', presenceHash, bestAgent)
if not raw then return nil end

local data = cjson.decode(raw)
local active = tonumber(data.activeConversations or 0)
local capacity = tonumber(data.maxCapacity or 0)
if active >= capacity then return nil end

active = active + 1
data.activeConversations = active
if active >= capacity then
  data.routingStatus = 'full'
else
  data.routingStatus = 'accept'
end

redis.call('HSET', presenceHash, bestAgent, cjson.encode(data))
redis.call('ZADD', loadZset, active, bestAgent)
return bestAgent
`;

/**
 * Capacity-based reserve: identical to LUA_RESERVE_FROM_CANDIDATES (lowest-load
 * wins, atomic increment, freshness guard) EXCEPT the effective capacity used for
 * the `active < capacity` gate is resolved with the tenant default as a fallback:
 *
 *   effectiveCapacity = agent.maxCapacity (if > 0) else tenantFallbackCapacity
 *
 * This mirrors AssignmentService.resolveAgentCapacity()'s priority
 * (per-agent → tenant default → hardcoded) but does it atomically inside Redis,
 * so capacity-based assignments increment the same load counter as every other
 * strategy. Previously the capacity-based path read MongoDB counts and returned an
 * agent WITHOUT reserving in Redis, causing (a) the load ZSET to under-count,
 * (b) a TOCTOU race, and (c) an erroneous rollback decrement.
 *
 * KEYS[1] = tenant presence hash
 * KEYS[2] = tenant load ZSET
 * ARGV[1] = number of candidates
 * ARGV[2..n] = candidate agent ids
 * ARGV[n+1]  = current Unix timestamp in ms (freshness check)
 * ARGV[n+2]  = heartbeat TTL in ms
 * ARGV[n+3]  = tenant fallback capacity
 *
 * Returns the selected agent id, or nil if no candidate is under capacity.
 */
const LUA_RESERVE_CAPACITY_BASED = `
local presenceHash = KEYS[1]
local loadZset = KEYS[2]
local candidateCount = tonumber(ARGV[1])
local nowMs = tonumber(ARGV[candidateCount + 2])
local heartbeatTtlMs = tonumber(ARGV[candidateCount + 3])
local tenantFallbackCap = tonumber(ARGV[candidateCount + 4])
local bestAgent = nil
local bestLoad = nil
local bestCap = nil

local function effectiveCap(agentCap)
  if agentCap and agentCap > 0 then return agentCap end
  if tenantFallbackCap and tenantFallbackCap > 0 then return tenantFallbackCap end
  return 0
end

for i = 1, candidateCount do
  local agentId = ARGV[i + 1]
  local raw = redis.call('HGET', presenceHash, agentId)
  if raw then
    local data = cjson.decode(raw)
    local active = tonumber(data.activeConversations or 0)
    local capacity = effectiveCap(tonumber(data.maxCapacity or 0))
    local heartbeatMs = tonumber(data.lastHeartbeatMs or 0)
    local isStale = nowMs - heartbeatMs > heartbeatTtlMs
    if not isStale
      and data.intentStatus == 'available'
      and data.connectionStatus == 'connected'
      and capacity > 0
      and active < capacity then
      local score = redis.call('ZSCORE', loadZset, agentId)
      local load = tonumber(score or active)
      if bestLoad == nil or load < bestLoad then
        bestLoad = load
        bestAgent = agentId
        bestCap = capacity
      end
    end
  end
end

if not bestAgent then return nil end

local raw = redis.call('HGET', presenceHash, bestAgent)
if not raw then return nil end

local data = cjson.decode(raw)
local active = tonumber(data.activeConversations or 0)
if active >= bestCap then return nil end

active = active + 1
data.activeConversations = active
-- routingStatus uses the agent's OWN stored capacity for display consistency.
local ownCap = tonumber(data.maxCapacity or 0)
if ownCap > 0 and active >= ownCap then
  data.routingStatus = 'full'
else
  data.routingStatus = 'accept'
end

redis.call('HSET', presenceHash, bestAgent, cjson.encode(data))
redis.call('ZADD', loadZset, active, bestAgent)
return bestAgent
`;

/**
 * First-fit reserve: walk the candidate list IN THE GIVEN ORDER and reserve the
 * FIRST eligible agent (not the lowest-load one). This is the round-robin
 * primitive — the caller passes an already-rotated list, and rotation fairness
 * is preserved only if we honour that order. Using LUA_RESERVE_FROM_CANDIDATES
 * here would silently collapse round-robin into least-busy.
 *
 * KEYS[1] = tenant presence hash
 * KEYS[2] = tenant load ZSET
 * ARGV[1] = number of candidates
 * ARGV[2..n] = candidate agent ids (in rotation order)
 * ARGV[n+1]  = current Unix timestamp in ms (freshness check)
 * ARGV[n+2]  = heartbeat TTL in ms
 *
 * Returns the first eligible agent id (incremented atomically), or nil.
 */
const LUA_RESERVE_FIRST_ELIGIBLE = `
local presenceHash = KEYS[1]
local loadZset = KEYS[2]
local candidateCount = tonumber(ARGV[1])
local nowMs = tonumber(ARGV[candidateCount + 2])
local heartbeatTtlMs = tonumber(ARGV[candidateCount + 3])

for i = 1, candidateCount do
  local agentId = ARGV[i + 1]
  local raw = redis.call('HGET', presenceHash, agentId)
  if raw then
    local data = cjson.decode(raw)
    local active = tonumber(data.activeConversations or 0)
    local capacity = tonumber(data.maxCapacity or 0)
    local heartbeatMs = tonumber(data.lastHeartbeatMs or 0)
    local isStale = nowMs - heartbeatMs > heartbeatTtlMs
    if not isStale
      and data.intentStatus == 'available'
      and data.connectionStatus == 'connected'
      and capacity > 0
      and active < capacity then
      -- First eligible in rotation order wins.
      active = active + 1
      data.activeConversations = active
      if active >= capacity then
        data.routingStatus = 'full'
      else
        data.routingStatus = 'accept'
      end
      redis.call('HSET', presenceHash, agentId, cjson.encode(data))
      redis.call('ZADD', loadZset, active, agentId)
      return agentId
    end
  end
end

return nil
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

  private async persistPresence(presence: AgentPresence): Promise<void> {
    const client = this.redis.getClient();
    const key = agentPresenceKey(presence.tenantId, presence.userId);
    const hashKey = tenantPresenceHashKey(presence.tenantId);
    const loadKey = tenantAgentLoadKey(presence.tenantId);

    // F-01: always stamp lastHeartbeatMs so the Lua script can compare numeric
    // timestamps atomically without parsing ISO date strings.
    presence.lastHeartbeatMs = new Date(presence.lastHeartbeat).getTime();

    const encoded = JSON.stringify(presence);

    const pipeline = client.pipeline();
    pipeline.setex(key, HEARTBEAT_TTL_SECONDS, encoded);
    pipeline.hset(hashKey, presence.userId, encoded);
    pipeline.zadd(loadKey, presence.activeConversations, presence.userId);
    // P1 fix: set a TTL on the shared hash and ZSET so stale entries from
    // crashed agents or inactive tenants don't accumulate indefinitely in
    // Redis memory. 24h is generous — these keys are refreshed on every
    // heartbeat (~30s interval) so the TTL is only hit when a tenant has
    // zero active agents for an entire day.
    pipeline.expire(hashKey, 86400); // 24 hours
    pipeline.expire(loadKey, 86400); // 24 hours
    await pipeline.exec();
  }

  private isPresenceFresh(presence: AgentPresence): boolean {
    const lastHeartbeat = new Date(presence.lastHeartbeat).getTime();
    return Date.now() - lastHeartbeat <= HEARTBEAT_TTL_SECONDS * 1000;
  }

  private parsePresence(raw: string): AgentPresence | null {
    try {
      return JSON.parse(raw) as AgentPresence;
    } catch {
      return null;
    }
  }

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
      lastHeartbeatMs: Date.now(),
      disconnectedAt: existing?.disconnectedAt,
      socketId: existing?.socketId,
    };

    await this.persistPresence(presence);

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
        this.logger.error(
          `Status transition callback failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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
      result.socketId = socketId;
      if (!result.connections.includes(socketId)) {
        result.connections.push(socketId);
      }
      await this.persistPresence(result);
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
    /**
     * Per-agent attributes resolved from the user record at connect time.
     * Hydrating here means skill-based routing and per-agent capacity work
     * without a MongoDB read on every assignment.
     */
    attributes?: { skills?: string[]; maxCapacity?: number },
  ): Promise<{ presence: AgentPresence; isFreshSession: boolean }> {
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

    // Per-agent capacity: prefer the freshly-resolved user value, else keep the
    // existing presence value, else the global default.
    const maxCapacity =
      attributes?.maxCapacity && attributes.maxCapacity > 0
        ? attributes.maxCapacity
        : (existing?.maxCapacity ?? DEFAULT_MAX_CAPACITY);

    const presence: AgentPresence = {
      userId,
      tenantId,
      intentStatus,
      connectionStatus: 'connected',
      routingStatus: computeRoutingStatus(
        existing?.activeConversations ?? 0,
        maxCapacity,
      ),
      status: computeDisplayStatus(intentStatus, 'connected'),
      activeConversations: existing?.activeConversations ?? 0,
      maxCapacity,
      // Hydrate skills from the user record; fall back to the existing cached
      // value on reconnect when no attributes were supplied.
      skills: attributes?.skills ?? existing?.skills,
      connections,
      lastHeartbeat: new Date(),
      lastHeartbeatMs: Date.now(),
      disconnectedAt: undefined,
      socketId,
    };

    await this.persistPresence(presence);

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
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Status transition callback failed: ${message}`);
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
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Status transition callback failed: ${message}`);
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

    await this.persistPresence(presence);

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
    const presence = await this.getPresence(tenantId, userId);
    if (presence) {
      presence.lastHeartbeat = new Date();
      await this.persistPresence(presence);
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
   * The counterpart to releaseConversation(), used by the routing engine
   * and manual assignment endpoints (F-09 fix) to keep Redis capacity in
   * sync when conversations are assigned directly via the REST API.
   *
   * If the agent has no presence record (offline/not in Redis), this is a no-op —
   * the count will be reconciled from MongoDB when they next connect.
   */
  async assignConversation(tenantId: string, userId: string): Promise<void> {
    const client = this.redis.getClient();
    const hashKey = tenantPresenceHashKey(tenantId);
    const loadKey = tenantAgentLoadKey(tenantId);

    const raw = await client.hget(hashKey, userId);
    if (!raw) return; // Agent not in Redis — no-op

    try {
      const data: AgentPresence = JSON.parse(raw);
      const active = (data.activeConversations ?? 0) + 1;
      data.activeConversations = active;
      data.routingStatus =
        active >= (data.maxCapacity ?? DEFAULT_MAX_CAPACITY) ? 'full' : 'accept';

      const encoded = JSON.stringify(data);
      const pipeline = client.pipeline();
      pipeline.hset(hashKey, userId, encoded);
      pipeline.zadd(loadKey, active, userId);
      await pipeline.exec();

      this.logger.debug(
        `Assigned conversation for agent ${userId} ` +
          `(${active}/${data.maxCapacity}) [routing: ${data.routingStatus}]`,
      );
    } catch {
      // Parse error — presence record is corrupted, skip silently
    }
  }


  /**
   * Atomically reserve the least-loaded eligible agent from a candidate list.
   * The Lua script runs entirely inside Redis: it checks presence eligibility,
   * capacity, ZSET score, increments load, and returns the selected agent id.
   */
  async reserveAgentFromCandidates(
    tenantId: string,
    candidateIds: string[],
  ): Promise<string | null> {
    const candidates = [...new Set(candidateIds.filter(Boolean))];
    if (candidates.length === 0) return null;

    const client = this.redis.getClient();
    const result = await client.eval(
      LUA_RESERVE_FROM_CANDIDATES,
      2,
      tenantPresenceHashKey(tenantId),
      tenantAgentLoadKey(tenantId),
      candidates.length.toString(),
      ...candidates,
      // F-01: pass current timestamp and TTL threshold so the Lua script
      // can reject stale Hash entries without an extra Redis round-trip.
      Date.now().toString(),
      (HEARTBEAT_TTL_SECONDS * 1000).toString(),
    );

    return typeof result === 'string' ? result : null;
  }

  /**
   * Atomically reserve the FIRST eligible agent from an ORDERED candidate list.
   * Used by `round-robin`: the caller passes an already-rotated list and this
   * honours that order (first-fit), instead of picking the lowest-load agent.
   * Replaces the previous N-round-trip loop (one Lua EVAL per candidate) with a
   * single EVAL while preserving rotation fairness. Set preserves insertion
   * order, so dedupe does not disturb the rotation.
   */
  async reserveFirstEligibleAgent(
    tenantId: string,
    orderedCandidateIds: string[],
  ): Promise<string | null> {
    const candidates = [...new Set(orderedCandidateIds.filter(Boolean))];
    if (candidates.length === 0) return null;

    const client = this.redis.getClient();
    const result = await client.eval(
      LUA_RESERVE_FIRST_ELIGIBLE,
      2,
      tenantPresenceHashKey(tenantId),
      tenantAgentLoadKey(tenantId),
      candidates.length.toString(),
      ...candidates,
      Date.now().toString(),
      (HEARTBEAT_TTL_SECONDS * 1000).toString(),
    );

    return typeof result === 'string' ? result : null;
  }

  /**
   * Atomically reserve the least-loaded eligible agent from a candidate list,
   * gating on the effective capacity (per-agent → tenant default → hardcoded).
   * Used by the `capacity-based` strategy. Increments the same load counter as
   * reserveAgentFromCandidates(), so all strategies stay in sync.
   */
  async reserveCapacityBasedAgent(
    tenantId: string,
    candidateIds: string[],
    tenantFallbackCapacity: number,
  ): Promise<string | null> {
    const candidates = [...new Set(candidateIds.filter(Boolean))];
    if (candidates.length === 0) return null;

    const client = this.redis.getClient();
    const result = await client.eval(
      LUA_RESERVE_CAPACITY_BASED,
      2,
      tenantPresenceHashKey(tenantId),
      tenantAgentLoadKey(tenantId),
      candidates.length.toString(),
      ...candidates,
      Date.now().toString(),
      (HEARTBEAT_TTL_SECONDS * 1000).toString(),
      (tenantFallbackCapacity > 0
        ? tenantFallbackCapacity
        : DEFAULT_MAX_CAPACITY
      ).toString(),
    );

    return typeof result === 'string' ? result : null;
  }

  /**
   * Atomically decrement the active conversation count for an agent.
   *
   * CRITICAL: This NEVER changes intentStatus. If the agent manually
   * set 'busy', they stay 'busy'. Only routingStatus changes
   * (full → accept when capacity frees up).
   */
  async releaseConversation(tenantId: string, userId: string): Promise<void> {
    const client = this.redis.getClient();

    const result = await client.eval(
      LUA_ATOMIC_RELEASE,
      2,
      tenantPresenceHashKey(tenantId),
      tenantAgentLoadKey(tenantId),
      userId,
    );

    if (result) {
      const updated: AgentPresence = JSON.parse(result as string);
      await client.setex(
        agentPresenceKey(tenantId, userId),
        HEARTBEAT_TTL_SECONDS,
        JSON.stringify(updated),
      );
      this.logger.log(
        `Released conversation for agent ${userId} ` +
          `(${updated.activeConversations}/${updated.maxCapacity}) ` +
          `[intent: ${updated.intentStatus}, routing: ${updated.routingStatus}]`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Reconciliation (P0 self-healing)
  // ────────────────────────────────────────────────────────────────────

  /**
   * Overwrite an agent's `activeConversations` counter with the authoritative
   * value from MongoDB. Recomputes `routingStatus` accordingly.
   *
   * Called by PresenceReconciliationService when drift is detected between the
   * Redis counter and MongoDB ground truth (e.g. after a Redis flush).
   *
   * @param tenantId  - tenant owning the agent
   * @param userId    - agent whose counter should be patched
   * @param actual    - authoritative count from MongoDB countDocuments
   */
  async patchActiveConversations(
    tenantId: string,
    userId: string,
    actual: number,
  ): Promise<void> {
    const client = this.redis.getClient();
    const hashKey = tenantPresenceHashKey(tenantId);
    const loadKey = tenantAgentLoadKey(tenantId);

    const raw = await client.hget(hashKey, userId);
    if (!raw) {
      this.logger.debug(
        `patchActiveConversations: agent ${userId} not in presence hash — skipping`,
      );
      return;
    }

    try {
      const data: AgentPresence = JSON.parse(raw);
      data.activeConversations = actual;
      data.routingStatus = actual >= data.maxCapacity ? 'full' : 'accept';

      // Recompute display status
      if (
        data.intentStatus === 'offline' ||
        data.connectionStatus === 'disconnected'
      ) {
        data.status = 'offline';
      } else {
        data.status = data.intentStatus as any;
      }

      const encoded = JSON.stringify(data);
      const pipeline = client.pipeline();
      pipeline.hset(hashKey, userId, encoded);
      pipeline.zadd(loadKey, actual, userId);
      pipeline.setex(agentPresenceKey(tenantId, userId), HEARTBEAT_TTL_SECONDS, encoded);
      await pipeline.exec();

      this.logger.log(
        `Patched activeConversations for agent ${userId} → ${actual} ` +
          `(routingStatus: ${data.routingStatus})`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to patch presence for agent ${userId}: ${err.message}`,
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
    const client = this.redis.getClient();
    const hashKey = tenantPresenceHashKey(tenantId);
    const rawFromHash = await client.hget(hashKey, userId);
    const fromHash = rawFromHash ? this.parsePresence(rawFromHash) : null;
    if (fromHash && this.isPresenceFresh(fromHash)) {
      return fromHash;
    }

    if (fromHash) {
      await client.hdel(hashKey, userId);
      await client.zrem(tenantAgentLoadKey(tenantId), userId);
    }

    const raw = await client.get(agentPresenceKey(tenantId, userId));
    const presence = raw ? this.parsePresence(raw) : null;
    if (!presence || !this.isPresenceFresh(presence)) return null;

    await this.persistPresence(presence);
    return presence;
  }

  /**
   * Get all agents for a tenant (any status).
   */
  async getAllAgents(tenantId: string): Promise<AgentPresence[]> {
    const client = this.redis.getClient();
    const hashKey = tenantPresenceHashKey(tenantId);
    const entries = await client.hgetall(hashKey);
    const agents: AgentPresence[] = [];

    const staleIds: string[] = [];
    for (const [agentId, raw] of Object.entries(entries)) {
      const presence = this.parsePresence(raw);
      if (presence && this.isPresenceFresh(presence)) {
        agents.push(presence);
      } else {
        staleIds.push(agentId);
      }
    }

    if (staleIds.length > 0) {
      const pipeline = client.pipeline();
      pipeline.hdel(hashKey, ...staleIds);
      pipeline.zrem(tenantAgentLoadKey(tenantId), ...staleIds);
      await pipeline.exec();
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
    const client = this.redis.getClient();
    const pipeline = client.pipeline();
    pipeline.del(agentPresenceKey(tenantId, userId));
    pipeline.hdel(tenantPresenceHashKey(tenantId), userId);
    pipeline.zrem(tenantAgentLoadKey(tenantId), userId);
    await pipeline.exec();
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

    await this.persistPresence(presence);

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

  /**
   * Update the cached skills for an agent in their Redis presence record.
   * No-op if the agent has no live presence (offline) — skills will be
   * re-hydrated from the user record on their next connect.
   */
  async updateAgentSkills(
    tenantId: string,
    userId: string,
    skills: string[],
  ): Promise<void> {
    const presence = await this.getPresence(tenantId, userId);
    if (!presence) return;
    presence.skills = skills ?? [];
    await this.persistPresence(presence);
    this.logger.debug(
      `Updated cached skills for agent ${userId} (${presence.skills.length} skills)`,
    );
  }

  /**
   * Keep cached per-agent attributes (skills, capacity) in sync when an admin
   * edits a user. Fired by UsersService on profile update. Bounded staleness:
   * if the agent is offline this is a no-op and the next connect re-hydrates.
   */
  @OnEvent('user.profile.updated')
  async handleUserProfileUpdated(event: {
    tenantId: string;
    userId: string;
    skills?: string[];
    omniMaxCapacity?: number | null;
  }): Promise<void> {
    if (!event?.tenantId || !event?.userId) return;
    try {
      if (event.skills !== undefined) {
        await this.updateAgentSkills(event.tenantId, event.userId, event.skills);
      }
      if (
        event.omniMaxCapacity !== undefined &&
        event.omniMaxCapacity !== null &&
        event.omniMaxCapacity > 0
      ) {
        await this.updateMaxCapacity(
          event.tenantId,
          event.userId,
          event.omniMaxCapacity,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `Failed to sync presence attributes for user ${event.userId}: ${err.message}`,
      );
    }
  }
}
