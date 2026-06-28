import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RedisService } from '../../redis/redis.service';
import {
  AgentPresence,
  AgentIntentStatus,
  StatusTransitionTrigger,
  agentPresenceKey,
  HEARTBEAT_TTL_SECONDS,
  DEFAULT_MAX_CAPACITY,
  tenantAgentLoadKey,
  tenantPresenceHashKey,
} from '../domain/agent-presence';
import {
  PresenceStatus,
  RoutingStatus,
  WorkStatus,
  computeCapacityStatus,
  computeDisplayStatus,
  fromLegacyIntent,
  isEligibleForRouting,
  toLegacyIntent,
} from '../domain/presence-state';
import { AxisSnapshot } from '../domain/presence-segments';
import {
  TransitionActor,
  applyDayRolloverReset,
  applyLogin,
  forceOffline,
  isStaleCommand,
  setRouting,
  transitionPresence,
} from '../domain/presence-state-machine';

// ────────────────────────────────────────────────────────────────────────
// Lua Scripts for atomic Redis operations
//
// The stored presence JSON uses the canonical 4-axis model:
//   presenceStatus  : AVAILABLE | AWAY | BREAK | MEETING | TRAINING | OFFLINE
//   routingStatus   : ACCEPTING | NOT_ACCEPTING   (the accept-work switch)
//   capacityStatus  : OK | FULL                   (derived from load)
//   connectionStatus: CONNECTED | DISCONNECTED
//
// Routing eligibility (§2.1) = presenceStatus==AVAILABLE && connectionStatus==
// CONNECTED && routingStatus==ACCEPTING && activeConversations < maxCapacity.
// ────────────────────────────────────────────────────────────────────────

/** Lua snippet recomputing the lowercase display `status` from the 4 axes. */
const LUA_RECOMPUTE_DISPLAY = `
local function recomputeDisplay(d)
  if d.presenceStatus == 'OFFLINE' or d.connectionStatus == 'DISCONNECTED' then
    d.status = 'offline'
  elseif d.presenceStatus == 'AVAILABLE' then
    if d.routingStatus == 'ACCEPTING' then d.status = 'available' else d.status = 'busy' end
  else
    d.status = 'away'
  end
end
`;

/**
 * Atomic release: decrement activeConversations, recompute capacityStatus.
 * NEVER touches presenceStatus or routingStatus.
 *
 * KEYS[1] = tenant presence hash, KEYS[2] = tenant load ZSET, ARGV[1] = agent id
 * Returns the updated presence JSON, or nil if key missing.
 */
const LUA_ATOMIC_RELEASE =
  LUA_RECOMPUTE_DISPLAY +
  `
local presenceHash = KEYS[1]
local loadZset = KEYS[2]
local agentId = ARGV[1]
local raw = redis.call('HGET', presenceHash, agentId)
if not raw then return nil end

local data = cjson.decode(raw)
data.activeConversations = math.max(0, data.activeConversations - 1)

if data.activeConversations < data.maxCapacity then
  data.capacityStatus = 'OK'
else
  data.capacityStatus = 'FULL'
end
recomputeDisplay(data)

redis.call('HSET', presenceHash, agentId, cjson.encode(data))
redis.call('ZADD', loadZset, data.activeConversations, agentId)
return cjson.encode(data)
`;

/** Shared eligibility predicate used inside every reserve script. */
const LUA_ELIGIBLE_FN = `
local function eligible(data, active, capacity, nowMs, ttlMs)
  local heartbeatMs = tonumber(data.lastHeartbeatMs or 0)
  local isStale = nowMs - heartbeatMs > ttlMs
  return (not isStale)
    and data.presenceStatus == 'AVAILABLE'
    and data.connectionStatus == 'CONNECTED'
    and data.routingStatus == 'ACCEPTING'
    and capacity > 0
    and active < capacity
end
`;

/**
 * Reserve the LEAST-loaded eligible agent from a candidate list (least-busy).
 *
 * ARGV[1]=count, ARGV[2..n]=ids, ARGV[n+1]=nowMs, ARGV[n+2]=heartbeatTtlMs
 */
const LUA_RESERVE_FROM_CANDIDATES =
  LUA_ELIGIBLE_FN +
  `
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
    if eligible(data, active, capacity, nowMs, heartbeatTtlMs) then
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
if active >= capacity then data.capacityStatus = 'FULL' else data.capacityStatus = 'OK' end

redis.call('HSET', presenceHash, bestAgent, cjson.encode(data))
redis.call('ZADD', loadZset, active, bestAgent)
return bestAgent
`;

/**
 * Capacity-based reserve: like least-busy but the eligibility capacity uses the
 * tenant fallback when the agent has no per-agent capacity.
 *
 * ARGV[1]=count, ids…, nowMs, heartbeatTtlMs, tenantFallbackCap
 */
const LUA_RESERVE_CAPACITY_BASED =
  LUA_RECOMPUTE_DISPLAY +
  `
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
    if (not isStale)
      and data.presenceStatus == 'AVAILABLE'
      and data.connectionStatus == 'CONNECTED'
      and data.routingStatus == 'ACCEPTING'
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
local ownCap = tonumber(data.maxCapacity or 0)
if ownCap > 0 and active >= ownCap then data.capacityStatus = 'FULL' else data.capacityStatus = 'OK' end
recomputeDisplay(data)

redis.call('HSET', presenceHash, bestAgent, cjson.encode(data))
redis.call('ZADD', loadZset, active, bestAgent)
return bestAgent
`;

/**
 * First-fit reserve: reserve the FIRST eligible agent in the given (rotated)
 * order — the round-robin primitive. ARGV layout matches the least-busy script.
 */
const LUA_RESERVE_FIRST_ELIGIBLE =
  LUA_ELIGIBLE_FN +
  `
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
    if eligible(data, active, capacity, nowMs, heartbeatTtlMs) then
      active = active + 1
      data.activeConversations = active
      if active >= capacity then data.capacityStatus = 'FULL' else data.capacityStatus = 'OK' end
      redis.call('HSET', presenceHash, agentId, cjson.encode(data))
      redis.call('ZADD', loadZset, active, agentId)
      return agentId
    end
  end
end

return nil
`;

/**
 * Callback invoked when an agent's legacy intent (derived from presence +
 * routing) changes. Wires audit logging without a circular dependency.
 */
export type StatusTransitionCallback = (
  tenantId: string,
  agentId: string,
  fromStatus: AgentIntentStatus,
  toStatus: AgentIntentStatus,
  trigger: StatusTransitionTrigger,
) => void | Promise<void>;

/**
 * Callback invoked on every canonical state change with the full before/after
 * axis snapshots — drives the reporting segment timeline (PresenceSegmentService).
 */
export type StateChangeCallback = (
  tenantId: string,
  agentId: string,
  before: AxisSnapshot | null,
  after: AxisSnapshot,
  trigger: StatusTransitionTrigger,
  atMs: number,
) => void | Promise<void>;

/** Redis SET of tenants with live presence — drives the rollover cron. */
export const ACTIVE_PRESENCE_TENANTS_KEY = 'omni:active_presence_tenants';

/**
 * Manages agent presence and capacity in Redis using the canonical 4-axis model
 * (presence-state.ts) + the pure state machine (presence-state-machine.ts).
 *
 *   - presenceStatus / routingStatus mutated via the state machine
 *   - capacityStatus / status are derived on every persist
 *   - atomic Lua scripts for capacity reserve/release (no race conditions)
 *   - multi-tab connection tracking + Last-Write-Wins guard (§1.6)
 *   - grace period handled by the gateway layer
 */
@Injectable()
export class AgentPresenceService {
  private readonly logger = new Logger(AgentPresenceService.name);

  /** Optional callback for audit logging of (legacy-intent) status transitions */
  private statusTransitionCallback?: StatusTransitionCallback;

  /** Optional callback for the canonical state-change reporting segments */
  private stateChangeCallback?: StateChangeCallback;

  constructor(private readonly redis: RedisService) {}

  // ────────────────────────────────────────────────────────────────────
  // Persistence helpers
  // ────────────────────────────────────────────────────────────────────

  /**
   * Recompute derived fields (capacityStatus, status display, lastHeartbeatMs)
   * and write the presence record to Redis (individual key + tenant hash + ZSET).
   */
  private async persistPresence(presence: AgentPresence): Promise<void> {
    const client = this.redis.getClient();
    const key = agentPresenceKey(presence.tenantId, presence.userId);
    const hashKey = tenantPresenceHashKey(presence.tenantId);
    const loadKey = tenantAgentLoadKey(presence.tenantId);

    // Derived fields — always recomputed so they can never drift.
    presence.capacityStatus = computeCapacityStatus(
      presence.activeConversations,
      presence.maxCapacity,
    );
    presence.status = computeDisplayStatus(
      presence.presenceStatus,
      presence.routingStatus,
      presence.connectionStatus,
    );
    presence.lastHeartbeatMs = new Date(presence.lastHeartbeat).getTime();

    const encoded = JSON.stringify(presence);

    const pipeline = client.pipeline();
    pipeline.setex(key, HEARTBEAT_TTL_SECONDS, encoded);
    pipeline.hset(hashKey, presence.userId, encoded);
    pipeline.zadd(loadKey, presence.activeConversations, presence.userId);
    pipeline.expire(hashKey, 86400);
    pipeline.expire(loadKey, 86400);
    // Track tenants with live presence so the rollover cron can enumerate them
    // without an O(N) Redis KEYS scan.
    pipeline.sadd(ACTIVE_PRESENCE_TENANTS_KEY, presence.tenantId);
    pipeline.expire(ACTIVE_PRESENCE_TENANTS_KEY, 86400 * 2);
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

  /** Build a fresh presence record from the canonical axes + connection info. */
  private buildPresence(
    base: Partial<AgentPresence> &
      Pick<AgentPresence, 'userId' | 'tenantId'>,
  ): AgentPresence {
    return {
      userId: base.userId,
      tenantId: base.tenantId,
      presenceStatus: base.presenceStatus ?? 'OFFLINE',
      routingStatus: base.routingStatus ?? 'NOT_ACCEPTING',
      workStatus: base.workStatus ?? 'IDLE',
      capacityStatus: 'OK',
      connectionStatus: base.connectionStatus ?? 'DISCONNECTED',
      status: 'offline',
      activeConversations: base.activeConversations ?? 0,
      maxCapacity: base.maxCapacity ?? DEFAULT_MAX_CAPACITY,
      skills: base.skills,
      connections: base.connections ?? [],
      lastHeartbeat: base.lastHeartbeat ?? new Date(),
      lastHeartbeatMs: base.lastHeartbeatMs ?? Date.now(),
      disconnectedAt: base.disconnectedAt,
      lastCommandTs: base.lastCommandTs,
      socketId: base.socketId,
    };
  }

  /**
   * Fire the audit callback when the legacy-intent projection of the state has
   * changed. The work-time report still consumes available/busy/away/offline.
   */
  private async fireAuditIfChanged(
    presence: AgentPresence,
    before: { presenceStatus: PresenceStatus; routingStatus: RoutingStatus } | null,
    trigger: StatusTransitionTrigger,
  ): Promise<void> {
    if (!this.statusTransitionCallback) return;
    const fromIntent: AgentIntentStatus = before
      ? toLegacyIntent(before.presenceStatus, before.routingStatus)
      : 'offline';
    const toIntent = toLegacyIntent(
      presence.presenceStatus,
      presence.routingStatus,
    );
    if (fromIntent === toIntent) return;
    try {
      await this.statusTransitionCallback(
        presence.tenantId,
        presence.userId,
        fromIntent,
        toIntent,
        trigger,
      );
    } catch (err) {
      this.logger.error(
        `Status transition callback failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  setStatusTransitionCallback(cb: StatusTransitionCallback): void {
    this.statusTransitionCallback = cb;
  }

  setStateChangeCallback(cb: StateChangeCallback): void {
    this.stateChangeCallback = cb;
  }

  /**
   * Fired after any state mutation: drives both the legacy work-time audit and
   * the canonical reporting segments.
   */
  private async afterMutation(
    presence: AgentPresence,
    before:
      | { presenceStatus: PresenceStatus; routingStatus: RoutingStatus; workStatus: WorkStatus }
      | null,
    trigger: StatusTransitionTrigger,
  ): Promise<void> {
    await this.fireAuditIfChanged(presence, before, trigger);
    if (this.stateChangeCallback) {
      try {
        await this.stateChangeCallback(
          presence.tenantId,
          presence.userId,
          before
            ? {
                presenceStatus: before.presenceStatus,
                routingStatus: before.routingStatus,
                workStatus: before.workStatus,
              }
            : null,
          {
            presenceStatus: presence.presenceStatus,
            routingStatus: presence.routingStatus,
            workStatus: presence.workStatus,
          },
          trigger,
          new Date(presence.lastHeartbeat).getTime(),
        );
      } catch (err) {
        this.logger.error(
          `State-change callback failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Tenants that currently have (or recently had) live presence. */
  async getActivePresenceTenants(): Promise<string[]> {
    return this.redis.getClient().smembers(ACTIVE_PRESENCE_TENANTS_KEY);
  }

  /**
   * Set the system-derived workStatus (§2.4). Records a work-axis segment via
   * afterMutation. No-op when there is no live presence or the value is unchanged.
   */
  async setWorkStatus(
    tenantId: string,
    userId: string,
    workStatus: WorkStatus,
  ): Promise<AgentPresence | null> {
    const existing = await this.getPresence(tenantId, userId);
    if (!existing) return null;
    if (existing.workStatus === workStatus) return existing;

    const before = {
      presenceStatus: existing.presenceStatus,
      routingStatus: existing.routingStatus,
      workStatus: existing.workStatus,
    };
    const presence: AgentPresence = {
      ...existing,
      workStatus,
      lastHeartbeat: new Date(),
    };
    await this.persistPresence(presence);
    await this.afterMutation(presence, before, 'system_work_status');
    return presence;
  }

  // ────────────────────────────────────────────────────────────────────
  // Presence & Routing (human-controlled)
  // ────────────────────────────────────────────────────────────────────

  /**
   * Change the presence axis (AVAILABLE/AWAY/BREAK/MEETING/TRAINING/OFFLINE)
   * via the state machine, applying the routing interlock (§1.2). Drops stale
   * multi-device commands (§1.6).
   */
  async applyPresence(
    tenantId: string,
    userId: string,
    to: PresenceStatus,
    trigger: StatusTransitionTrigger = 'agent_manual',
    opts: {
      actor?: TransitionActor;
      clientTs?: number;
      restoreAcceptingOnReturn?: boolean;
      wasAcceptingBeforeLeave?: boolean;
    } = {},
  ): Promise<AgentPresence | null> {
    const existing =
      (await this.getPresence(tenantId, userId)) ??
      this.buildPresence({ userId, tenantId });

    if (opts.clientTs !== undefined && isStaleCommand(opts.clientTs, existing.lastCommandTs)) {
      this.logger.debug(
        `Dropping stale presence command for ${userId} (clientTs=${opts.clientTs} < ${existing.lastCommandTs})`,
      );
      return existing;
    }

    const now = Date.now();
    const result = transitionPresence(
      {
        presenceStatus: existing.presenceStatus,
        routingStatus: existing.routingStatus,
        workStatus: existing.workStatus,
        connectionStatus: existing.connectionStatus,
        currentLoad: existing.activeConversations,
        maxLoad: existing.maxCapacity,
        updatedAtMs: existing.lastHeartbeatMs,
      },
      to,
      {
        trigger,
        nowMs: now,
        actor: opts.actor ?? 'agent',
        restoreAcceptingOnReturn: opts.restoreAcceptingOnReturn,
        wasAcceptingBeforeLeave:
          opts.wasAcceptingBeforeLeave ?? existing.routingStatus === 'ACCEPTING',
      },
    );

    if (!result.ok) {
      this.logger.warn(`Presence transition rejected for ${userId}: ${result.error}`);
      return existing;
    }

    const before = {
      presenceStatus: existing.presenceStatus,
      routingStatus: existing.routingStatus,
      workStatus: existing.workStatus,
    };
    const presence: AgentPresence = {
      ...existing,
      presenceStatus: result.state.presenceStatus,
      routingStatus: result.state.routingStatus,
      lastHeartbeat: new Date(),
      lastCommandTs: opts.clientTs ?? existing.lastCommandTs,
    };

    await this.persistPresence(presence);
    this.logger.log(
      `Agent ${userId} presence → ${presence.presenceStatus} / routing → ${presence.routingStatus} (${trigger})`,
    );
    await this.afterMutation(presence, before, trigger);
    return presence;
  }

  /**
   * Toggle the accept-work switch (ACCEPTING/NOT_ACCEPTING). Only valid while
   * AVAILABLE + CONNECTED.
   */
  async setRoutingControl(
    tenantId: string,
    userId: string,
    routing: RoutingStatus,
    trigger: StatusTransitionTrigger = 'agent_manual',
    opts: { clientTs?: number } = {},
  ): Promise<AgentPresence | null> {
    const existing = await this.getPresence(tenantId, userId);
    if (!existing) return null;

    if (opts.clientTs !== undefined && isStaleCommand(opts.clientTs, existing.lastCommandTs)) {
      return existing;
    }

    const result = setRouting(
      {
        presenceStatus: existing.presenceStatus,
        routingStatus: existing.routingStatus,
        workStatus: existing.workStatus,
        connectionStatus: existing.connectionStatus,
        currentLoad: existing.activeConversations,
        maxLoad: existing.maxCapacity,
        updatedAtMs: existing.lastHeartbeatMs,
      },
      routing,
      { trigger, nowMs: Date.now() },
    );

    if (!result.ok) {
      this.logger.warn(`Routing change rejected for ${userId}: ${result.error}`);
      return existing;
    }

    const before = {
      presenceStatus: existing.presenceStatus,
      routingStatus: existing.routingStatus,
      workStatus: existing.workStatus,
    };
    const presence: AgentPresence = {
      ...existing,
      routingStatus: result.state.routingStatus,
      lastHeartbeat: new Date(),
      lastCommandTs: opts.clientTs ?? existing.lastCommandTs,
    };
    await this.persistPresence(presence);
    await this.afterMutation(presence, before, trigger);
    return presence;
  }

  /**
   * Legacy intent shim — maps available/busy/away/offline onto the canonical
   * (presence, routing) pair (Busy = AVAILABLE + NOT_ACCEPTING, §1.2). Used by
   * the existing frontend's `agent:status:update` event and grace expiry.
   */
  async updateIntentStatus(
    tenantId: string,
    userId: string,
    intent: AgentIntentStatus,
    trigger: StatusTransitionTrigger = 'agent_manual',
    opts: { clientTs?: number } = {},
  ): Promise<AgentPresence> {
    const { presenceStatus, routingStatus } = fromLegacyIntent(intent);
    const existing =
      (await this.getPresence(tenantId, userId)) ??
      this.buildPresence({ userId, tenantId });

    if (opts.clientTs !== undefined && isStaleCommand(opts.clientTs, existing.lastCommandTs)) {
      return existing;
    }

    const before = {
      presenceStatus: existing.presenceStatus,
      routingStatus: existing.routingStatus,
      workStatus: existing.workStatus,
    };
    const presence: AgentPresence = {
      ...existing,
      presenceStatus,
      // 'available' wants ACCEPTING, 'busy' wants NOT_ACCEPTING — honour intent
      // directly here since this is an explicit agent command, not a return.
      routingStatus,
      lastHeartbeat: new Date(),
      lastCommandTs: opts.clientTs ?? existing.lastCommandTs,
    };
    await this.persistPresence(presence);
    this.logger.log(`Agent ${userId} intent → ${intent} (${trigger})`);
    await this.afterMutation(presence, before, trigger);
    return presence;
  }

  // ────────────────────────────────────────────────────────────────────
  // Connection Tracking (system-controlled, multi-tab)
  // ────────────────────────────────────────────────────────────────────

  /**
   * Register a new socket connection for an agent.
   *
   * - Fresh session  → login: AVAILABLE + NOT_ACCEPTING (or ACCEPTING if the
   *   tenant opts into autoAvailableOnConnect — never the default, §2.2).
   * - Reconnect within grace → restore previous presence + routing.
   * - Additional tab → keep current state.
   */
  async addConnection(
    tenantId: string,
    userId: string,
    socketId: string,
    autoAvailableOnConnect: boolean = false,
    attributes?: { skills?: string[]; maxCapacity?: number },
  ): Promise<{ presence: AgentPresence; isFreshSession: boolean }> {
    const existing = await this.getPresence(tenantId, userId);
    const isFreshSession = !existing;

    const connections = existing?.connections
      ? [...existing.connections.filter((id) => id !== socketId), socketId]
      : [socketId];

    const maxCapacity =
      attributes?.maxCapacity && attributes.maxCapacity > 0
        ? attributes.maxCapacity
        : (existing?.maxCapacity ?? DEFAULT_MAX_CAPACITY);

    let presenceStatus: PresenceStatus;
    let routingStatus: RoutingStatus;
    let trigger: StatusTransitionTrigger;

    if (isFreshSession) {
      // Login always lands AVAILABLE; only an explicit tenant opt-in arms routing.
      presenceStatus = 'AVAILABLE';
      routingStatus = autoAvailableOnConnect ? 'ACCEPTING' : 'NOT_ACCEPTING';
      trigger = 'system_login';
    } else {
      // Reconnect or additional tab → keep prior canonical state.
      presenceStatus = existing.presenceStatus;
      routingStatus = existing.routingStatus;
      trigger =
        existing.connectionStatus === 'DISCONNECTED'
          ? 'system_reconnect'
          : 'system_connect';
    }

    const before = existing
      ? {
          presenceStatus: existing.presenceStatus,
          routingStatus: existing.routingStatus,
          workStatus: existing.workStatus,
        }
      : null;

    const presence = this.buildPresence({
      userId,
      tenantId,
      presenceStatus,
      routingStatus,
      workStatus: existing?.workStatus ?? 'IDLE',
      connectionStatus: 'CONNECTED',
      activeConversations: existing?.activeConversations ?? 0,
      maxCapacity,
      skills: attributes?.skills ?? existing?.skills,
      connections,
      lastHeartbeat: new Date(),
      disconnectedAt: undefined,
      lastCommandTs: existing?.lastCommandTs,
      socketId,
    });

    await this.persistPresence(presence);
    this.logger.log(
      `Agent ${userId} socket ${socketId} connected ` +
        `(fresh=${isFreshSession}, ${connections.length} connections, ` +
        `presence=${presence.presenceStatus})`,
    );

    await this.afterMutation(presence, before, trigger);
    return { presence, isFreshSession };
  }

  /**
   * Remove a socket connection. When the last connection is gone, mark the
   * connection DISCONNECTED and record disconnectedAt (grace period handled by
   * the gateway). Does NOT change presenceStatus — grace expiry does that.
   */
  async removeConnection(
    tenantId: string,
    userId: string,
    socketId: string,
  ): Promise<{ presence: AgentPresence | null; allDisconnected: boolean }> {
    const existing = await this.getPresence(tenantId, userId);
    if (!existing) {
      return { presence: null, allDisconnected: true };
    }

    const connections = existing.connections.filter((id) => id !== socketId);
    const allDisconnected = connections.length === 0;

    const presence: AgentPresence = {
      ...existing,
      connections,
      connectionStatus: allDisconnected ? 'DISCONNECTED' : 'CONNECTED',
      disconnectedAt: allDisconnected ? new Date() : existing.disconnectedAt,
      lastHeartbeat: new Date(),
    };
    if (existing.socketId === socketId) {
      presence.socketId = connections[0];
    }

    await this.persistPresence(presence);
    this.logger.log(
      `Agent ${userId} socket ${socketId} disconnected ` +
        `(${connections.length} remaining, allDisconnected=${allDisconnected})`,
    );
    return { presence, allDisconnected };
  }

  // ────────────────────────────────────────────────────────────────────
  // Grace Period Expiry
  // ────────────────────────────────────────────────────────────────────

  /**
   * Called when the grace period expires without reconnection. Forces OFFLINE.
   */
  async handleGracePeriodExpired(
    tenantId: string,
    userId: string,
  ): Promise<AgentPresence | null> {
    const existing = await this.getPresence(tenantId, userId);
    if (!existing) return null;

    if (existing.connectionStatus === 'CONNECTED') {
      this.logger.debug(
        `Grace period expired for agent ${userId} but already reconnected — skipping`,
      );
      return existing;
    }

    const before = {
      presenceStatus: existing.presenceStatus,
      routingStatus: existing.routingStatus,
      workStatus: existing.workStatus,
    };
    const result = forceOffline(
      {
        presenceStatus: existing.presenceStatus,
        routingStatus: existing.routingStatus,
        workStatus: existing.workStatus,
        connectionStatus: existing.connectionStatus,
        currentLoad: existing.activeConversations,
        maxLoad: existing.maxCapacity,
        updatedAtMs: existing.lastHeartbeatMs,
      },
      { trigger: 'system_grace_expired', nowMs: Date.now(), actor: 'system' },
    );
    const presence: AgentPresence = {
      ...existing,
      presenceStatus: result.state.presenceStatus,
      routingStatus: result.state.routingStatus,
      connectionStatus: 'DISCONNECTED',
      lastHeartbeat: new Date(),
    };
    await this.persistPresence(presence);
    await this.afterMutation(presence, before, 'system_grace_expired');
    return presence;
  }

  /**
   * Midnight rollover (§3.2) — reset routing to NOT_ACCEPTING for an agent who
   * is online across the day boundary. Presence is preserved; the segment is
   * cut by the rollover cron (Phase 2). Returns true if routing changed.
   */
  async applyDayRollover(tenantId: string, userId: string): Promise<boolean> {
    const existing = await this.getPresence(tenantId, userId);
    if (!existing) return false;
    const result = applyDayRolloverReset(
      {
        presenceStatus: existing.presenceStatus,
        routingStatus: existing.routingStatus,
        workStatus: existing.workStatus,
        connectionStatus: existing.connectionStatus,
        currentLoad: existing.activeConversations,
        maxLoad: existing.maxCapacity,
        updatedAtMs: existing.lastHeartbeatMs,
      },
      Date.now(),
    );
    if (result.changed.length === 0) return false;
    const before = {
      presenceStatus: existing.presenceStatus,
      routingStatus: existing.routingStatus,
      workStatus: existing.workStatus,
    };
    const presence: AgentPresence = {
      ...existing,
      routingStatus: result.state.routingStatus,
      lastHeartbeat: new Date(),
    };
    await this.persistPresence(presence);
    await this.afterMutation(presence, before, 'system_day_rollover');
    return true;
  }

  // ────────────────────────────────────────────────────────────────────
  // Heartbeat
  // ────────────────────────────────────────────────────────────────────

  async heartbeat(tenantId: string, userId: string): Promise<void> {
    const presence = await this.getPresence(tenantId, userId);
    if (presence) {
      presence.lastHeartbeat = new Date();
      await this.persistPresence(presence);
    } else {
      this.logger.warn(
        `Heartbeat for agent ${userId} but no presence key — ignoring ` +
          `(will re-register on reconnect)`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Capacity Operations (atomic via Lua scripts)
  // ────────────────────────────────────────────────────────────────────

  /**
   * Atomically increment the active conversation count (used by direct/manual
   * assignment to keep Redis in sync). No-op if the agent has no presence.
   */
  async assignConversation(tenantId: string, userId: string): Promise<void> {
    const client = this.redis.getClient();
    const hashKey = tenantPresenceHashKey(tenantId);
    const loadKey = tenantAgentLoadKey(tenantId);

    const raw = await client.hget(hashKey, userId);
    if (!raw) return;

    try {
      const data: AgentPresence = JSON.parse(raw);
      const active = (data.activeConversations ?? 0) + 1;
      data.activeConversations = active;
      data.capacityStatus = computeCapacityStatus(
        active,
        data.maxCapacity ?? DEFAULT_MAX_CAPACITY,
      );

      const encoded = JSON.stringify(data);
      const pipeline = client.pipeline();
      pipeline.hset(hashKey, userId, encoded);
      pipeline.zadd(loadKey, active, userId);
      await pipeline.exec();
    } catch {
      // Corrupted record — skip silently
    }
  }

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
      Date.now().toString(),
      (HEARTBEAT_TTL_SECONDS * 1000).toString(),
    );
    return typeof result === 'string' ? result : null;
  }

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
   * Atomically decrement the active conversation count. NEVER changes
   * presenceStatus or routingStatus — only capacityStatus (FULL → OK).
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
          `[presence: ${updated.presenceStatus}, capacity: ${updated.capacityStatus}]`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Reconciliation (P0 self-healing)
  // ────────────────────────────────────────────────────────────────────

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
      data.capacityStatus = computeCapacityStatus(actual, data.maxCapacity);
      data.status = computeDisplayStatus(
        data.presenceStatus,
        data.routingStatus,
        data.connectionStatus,
      );

      const encoded = JSON.stringify(data);
      const pipeline = client.pipeline();
      pipeline.hset(hashKey, userId, encoded);
      pipeline.zadd(loadKey, actual, userId);
      pipeline.setex(agentPresenceKey(tenantId, userId), HEARTBEAT_TTL_SECONDS, encoded);
      await pipeline.exec();

      this.logger.log(
        `Patched activeConversations for agent ${userId} → ${actual} ` +
          `(capacity: ${data.capacityStatus})`,
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
   * Get all agents eligible for auto-assignment (§2.1): AVAILABLE + CONNECTED +
   * ACCEPTING + under capacity.
   */
  async getAvailableAgents(tenantId: string): Promise<AgentPresence[]> {
    const allAgents = await this.getAllAgents(tenantId);
    return allAgents.filter((a) =>
      isEligibleForRouting({
        presenceStatus: a.presenceStatus,
        connectionStatus: a.connectionStatus,
        routingStatus: a.routingStatus,
        currentLoad: a.activeConversations,
        maxLoad: a.maxCapacity,
      }),
    );
  }

  async getOnlineAgents(tenantId: string): Promise<string[]> {
    const available = await this.getAvailableAgents(tenantId);
    return available.map((a) => a.userId);
  }

  // ────────────────────────────────────────────────────────────────────
  // Administration
  // ────────────────────────────────────────────────────────────────────

  async removePresence(tenantId: string, userId: string): Promise<void> {
    const client = this.redis.getClient();
    const pipeline = client.pipeline();
    pipeline.del(agentPresenceKey(tenantId, userId));
    pipeline.hdel(tenantPresenceHashKey(tenantId), userId);
    pipeline.zrem(tenantAgentLoadKey(tenantId), userId);
    await pipeline.exec();
    this.logger.log(`Agent ${userId} removed from presence`);
  }

  async updateMaxCapacity(
    tenantId: string,
    userId: string,
    maxCapacity: number,
  ): Promise<void> {
    const presence = await this.getPresence(tenantId, userId);
    if (!presence) return;
    presence.maxCapacity = maxCapacity;
    await this.persistPresence(presence);
    this.logger.log(
      `Updated max capacity for agent ${userId} to ${maxCapacity} ` +
        `[capacity: ${presence.capacityStatus}]`,
    );
  }

  async getAgentCapacity(tenantId: string, userId: string): Promise<number> {
    const presence = await this.getPresence(tenantId, userId);
    return presence?.maxCapacity ?? DEFAULT_MAX_CAPACITY;
  }

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
