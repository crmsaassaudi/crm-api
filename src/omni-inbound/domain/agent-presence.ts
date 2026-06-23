// ─── 3-Axis State Model ─────────────────────────────────────────────
//
// The Agent Status system separates three independent concerns:
//   1. Intent    — what the AGENT chose (available, busy, away, offline)
//   2. Connection — what the NETWORK says (connected, disconnected)
//   3. Routing   — what the SYSTEM computed (accept, full)
//
// The display `status` is deterministically derived from these three axes.
// Routing eligibility is a simple boolean AND of all three conditions.
// ────────────────────────────────────────────────────────────────────

/** Agent's own chosen state — set manually via UI */
export type AgentIntentStatus = 'available' | 'busy' | 'away' | 'offline';

/** System-detected network connectivity */
export type AgentConnectionStatus = 'connected' | 'disconnected';

/** System-computed based on capacity load */
export type AgentRoutingStatus = 'accept' | 'full';

/**
 * Backward-compatible display status — computed from the 3 axes.
 * Used by the frontend UI and older consumers that read `status`.
 */
export type AgentStatus = 'available' | 'busy' | 'away' | 'offline';

/**
 * What caused an intent status transition — used for audit logging.
 */
export type StatusTransitionTrigger =
  | 'agent_manual' // Agent clicked a status in the UI
  | 'system_grace_expired' // Grace period expired → forced offline
  | 'system_disconnect' // All connections lost (before grace)
  | 'system_reconnect' // Agent reconnected within grace period
  | 'system_connect' // Fresh session started (first connect)
  | 'system_auto_available'; // Auto-available on connect (tenant setting)

// ─── Agent Presence ─────────────────────────────────────────────────

/**
 * Agent presence — tracks the real-time state of a support agent.
 *
 * Stored in Redis for fast reads and TTL-based auto-expiry (heartbeat).
 * The three status axes are independently managed:
 *   - intentStatus    → only the agent (or grace-period expiry) can change
 *   - connectionStatus → only socket connect/disconnect events change
 *   - routingStatus   → only capacity changes (assign/release) change
 */
export interface AgentPresence {
  /** Our internal user id */
  userId: string;

  tenantId: string;

  // ── 3-Axis Status ──────────────────────────────────────────────

  /** Agent's manually chosen status */
  intentStatus: AgentIntentStatus;

  /** System-detected connectivity */
  connectionStatus: AgentConnectionStatus;

  /** System-computed routing eligibility based on capacity */
  routingStatus: AgentRoutingStatus;

  /**
   * Backward-compatible computed display status.
   * Derived from the 3 axes via `computeDisplayStatus()`.
   */
  status: AgentStatus;

  // ── Capacity ───────────────────────────────────────────────────

  /** How many active (open) conversations this agent is handling right now */
  activeConversations: number;

  /** Maximum concurrent conversations (per-agent or global default) */
  maxCapacity: number;

  // ── Connection Tracking ────────────────────────────────────────

  /** Active socket IDs — multi-tab/multi-device support */
  connections: string[];

  /** Last heartbeat timestamp — if stale, agent is considered offline */
  lastHeartbeat: Date;

  /**
   * Last heartbeat as Unix milliseconds (numeric).
   * Stored alongside the ISO string so Lua scripts can compare timestamps
   * atomically inside Redis without parsing date strings.
   */
  lastHeartbeatMs: number;

  /** When all connections were lost — used for grace period calculation */
  disconnectedAt?: Date;

  /**
   * @deprecated Use `connections[0]` or targeted events instead.
   * Kept for backward compatibility during migration.
   */
  socketId?: string;
}

// ─── Pure Functions ─────────────────────────────────────────────────

/**
 * Deterministically compute the display status from the 3 axes.
 *
 * Rules:
 *   1. If intent is 'offline' → offline (agent chose to go offline)
 *   2. If connection is 'disconnected' → offline (network is down)
 *   3. Otherwise → mirror the intent status (available, busy, away)
 *
 * Note: routingStatus does NOT affect display status — it only affects
 * whether the agent is eligible for auto-assignment. An "available" agent
 * who is "full" still displays as "available" (with an "At Capacity" badge).
 */
export function computeDisplayStatus(
  intent: AgentIntentStatus,
  connection: AgentConnectionStatus,
): AgentStatus {
  if (intent === 'offline') return 'offline';
  if (connection === 'disconnected') return 'offline';
  return intent; // 'available' | 'busy' | 'away'
}

/**
 * Determine if an agent should receive new auto-assigned conversations.
 *
 * All three conditions must be true:
 *   1. Agent chose "available" (not busy/away/offline)
 *   2. Network connection is active
 *   3. Has remaining capacity (not at max)
 */
export function isEligibleForRouting(presence: AgentPresence): boolean {
  return (
    presence.intentStatus === 'available' &&
    presence.connectionStatus === 'connected' &&
    presence.routingStatus === 'accept'
  );
}

/**
 * Compute routing status from current capacity.
 */
export function computeRoutingStatus(
  activeConversations: number,
  maxCapacity: number,
): AgentRoutingStatus {
  return activeConversations >= maxCapacity ? 'full' : 'accept';
}

// ─── Redis Key Helpers ──────────────────────────────────────────────

export const AGENT_PRESENCE_PREFIX = 'omni:agent:presence';

export const agentPresenceKey = (tenantId: string, userId: string) =>
  `${AGENT_PRESENCE_PREFIX}:${tenantId}:${userId}`;

// T12 fix: tenantAgentsKey() removed — never used in production.
// AgentPresenceService uses tenantPresenceHashKey() + HGETALL for bulk tenant
// presence reads. KEYS-scan patterns (glob) are O(N) and blocked on production Redis.

export const tenantPresenceHashKey = (tenantId: string) =>
  `omni:presence:${tenantId}`;

export const tenantAgentLoadKey = (tenantId: string) =>
  `omni:agent_load:${tenantId}`;

// ─── Constants ──────────────────────────────────────────────────────

/** Heartbeat TTL — if an agent doesn't heartbeat within this window, Redis expires the key */
export const HEARTBEAT_TTL_SECONDS = 120; // 2 minutes (aligned with grace period)

/** Grace period before marking a disconnected agent as offline (ms) */
export const GRACE_PERIOD_MS = 2 * 60 * 1000; // 2 minutes

/** Default max capacity when no per-agent or tenant setting exists */
export const DEFAULT_MAX_CAPACITY = 10;
