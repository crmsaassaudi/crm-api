// ─── Agent Presence (Redis record) ──────────────────────────────────────────
//
// The persisted/real-time shape of an agent's presence in Redis. It composes
// the canonical 4-axis state (presence-state.ts) with connection-tracking and
// capacity fields. See docs/agent-presence-workforce-spec.md §1, §3.3.
//
//   presenceStatus  — where the agent is (AVAILABLE/AWAY/BREAK/MEETING/TRAINING/OFFLINE)
//   routingStatus   — the accept-new-work switch (ACCEPTING/NOT_ACCEPTING)
//   workStatus      — what the agent is doing (system-derived, display only)
//   capacityStatus  — OK/FULL, derived from currentLoad vs maxLoad
//   connectionStatus — CONNECTED/DISCONNECTED (infra)
//
// `status` is a lowercase legacy display value kept for the existing frontend
// and the work-time report; it is derived, never authoritative.
// ─────────────────────────────────────────────────────────────────────────────

import {
  CapacityStatus,
  ConnectionStatus,
  LegacyIntentStatus,
  PresenceStatus,
  RoutingStatus,
  WorkStatus,
} from './presence-state';
import { TransitionTrigger } from './presence-state-machine';

// Re-export the canonical model + state machine so callers can import either
// from the pure modules or from this presence aggregate.
export * from './presence-state';
export * from './presence-state-machine';

/** @deprecated legacy alias — the canonical trigger type is TransitionTrigger. */
export type StatusTransitionTrigger = TransitionTrigger;

/** @deprecated legacy alias — used by the work-time report. */
export type AgentIntentStatus = LegacyIntentStatus;

/** @deprecated legacy alias for the lowercase display status. */
export type AgentStatus = LegacyIntentStatus;

/**
 * Agent presence — the real-time state of a support agent, stored in Redis for
 * fast reads and TTL-based auto-expiry (heartbeat).
 */
export interface AgentPresence {
  userId: string;
  tenantId: string;

  // ── 4-Axis canonical state ─────────────────────────────────────────────────
  presenceStatus: PresenceStatus;
  routingStatus: RoutingStatus;
  workStatus: WorkStatus;
  capacityStatus: CapacityStatus;
  connectionStatus: ConnectionStatus;

  /** Derived lowercase display status for the legacy UI / work-time report. */
  status: LegacyIntentStatus;

  // ── Capacity ───────────────────────────────────────────────────────────────
  activeConversations: number;
  maxCapacity: number;

  /** Skills cached from the user record at connect time for skill-based routing. */
  skills?: string[];

  // ── Connection tracking ──────────────────────────────────────────────────
  /** Active socket IDs — multi-tab/multi-device support (§1.6). */
  connections: string[];

  lastHeartbeat: Date;
  /** Unix ms mirror of lastHeartbeat so Lua can compare numerically. */
  lastHeartbeatMs: number;

  /** When all connections were lost — drives grace-period calculation. */
  disconnectedAt?: Date;

  /**
   * Client timestamp of the last applied status command — the multi-device
   * Last-Write-Wins monotonic guard (§1.6). Stale commands are dropped.
   */
  lastCommandTs?: number;

  /** @deprecated kept for backward compatibility during migration. */
  socketId?: string;
}

// ─── Redis Key Helpers ──────────────────────────────────────────────────────

export const AGENT_PRESENCE_PREFIX = 'omni:agent:presence';

export const agentPresenceKey = (tenantId: string, userId: string) =>
  `${AGENT_PRESENCE_PREFIX}:${tenantId}:${userId}`;

export const tenantPresenceHashKey = (tenantId: string) =>
  `omni:presence:${tenantId}`;

export const tenantAgentLoadKey = (tenantId: string) =>
  `omni:agent_load:${tenantId}`;

// ─── Constants ──────────────────────────────────────────────────────────────
// NOTE: heartbeat/grace are still hardcoded here. Phase 2.5 wires them to the
// `omni_presence` tenant setting (heartbeatTimeout=60s, gracePeriod=120s).

/** Heartbeat TTL — Redis expires the presence key if no heartbeat within this. */
export const HEARTBEAT_TTL_SECONDS = 120;

/** Grace period before marking a disconnected agent OFFLINE (ms). */
export const GRACE_PERIOD_MS = 2 * 60 * 1000;

/** Default max capacity when no per-agent or tenant setting exists. */
export const DEFAULT_MAX_CAPACITY = 10;
