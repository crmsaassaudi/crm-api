// Canonical 4-Axis Agent State Model
//
// This is the canonical presence/routing/work model defined in
// docs/agent-presence-workforce-spec.md §1. It supersedes the legacy 3-axis
// model in `agent-presence.ts` (intentStatus × connectionStatus × routingStatus
// where routingStatus meant capacity). The four axes are orthogonal:
//
//   1. presenceStatus  — where the agent is (agent-chosen; OFFLINE is system)
//   2. routingStatus   — the "accept new work" switch (agent/supervisor)
//   3. workStatus      — what the agent is doing (system-derived, display only)
//   4. capacity        — currentLoad / maxLoad (quantitative gate)
//
//   + connectionStatus — infra: is the socket alive (CONNECTED/DISCONNECTED)
//
// "Busy" is NOT a presence — it is AVAILABLE + NOT_ACCEPTING (§1.2).

/** Where the agent is, at a macro level. OFFLINE is set by the system only. */
export type PresenceStatus =
  | 'AVAILABLE'
  | 'AWAY'
  | 'BREAK'
  | 'MEETING'
  | 'TRAINING'
  | 'OFFLINE';

/** The "accept new work" switch — controlled by the agent or a supervisor. */
export type RoutingStatus = 'ACCEPTING' | 'NOT_ACCEPTING';

/** What the agent is doing right now — system-derived, display/report only. */
export type WorkStatus =
  | 'IDLE'
  | 'IN_CHAT'
  | 'IN_TICKET'
  | 'IN_EMAIL'
  | 'IN_CALL'
  | 'WRAP_UP';

/** Derived from currentLoad vs maxLoad. Not stored as an independent axis. */
export type CapacityStatus = 'OK' | 'FULL';

/** Infra-level socket connectivity. */
export type ConnectionStatus = 'CONNECTED' | 'DISCONNECTED';

export const PRESENCE_STATUSES: readonly PresenceStatus[] = [
  'AVAILABLE',
  'AWAY',
  'BREAK',
  'MEETING',
  'TRAINING',
  'OFFLINE',
];

/** Presence values that are "online" (counted in T_online for reporting §4). */
export const ONLINE_PRESENCE_STATUSES: readonly PresenceStatus[] = [
  'AVAILABLE',
  'AWAY',
  'BREAK',
  'MEETING',
  'TRAINING',
];

/**
 * The only presence in which an agent can be routed new work.
 * AWAY/BREAK/MEETING/TRAINING/OFFLINE are never routable (§1.1).
 */
export const ROUTABLE_PRESENCE: PresenceStatus = 'AVAILABLE';

/** WorkStatus priority for the single display label when multitasking (§2.4). */
export const WORK_STATUS_PRIORITY: readonly WorkStatus[] = [
  'IN_CALL',
  'IN_CHAT',
  'IN_TICKET',
  'IN_EMAIL',
  'WRAP_UP',
  'IDLE',
];

/**
 * Canonical agent state. Held in Redis for fast reads; each axis change emits a
 * closed segment to `agent_state_segments` for reporting (§3).
 */
export interface AgentState {
  presenceStatus: PresenceStatus;
  routingStatus: RoutingStatus;
  workStatus: WorkStatus;
  connectionStatus: ConnectionStatus;

  currentLoad: number;
  maxLoad: number;

  /**
   * Server-stamped time (ms) of the last accepted mutation. Used as the
   * monotonic guard for multi-device Last-Write-Wins (§1.6).
   */
  updatedAtMs: number;
}

// Pure Predicates

export function isOnline(presence: PresenceStatus): boolean {
  return presence !== 'OFFLINE';
}

export function isRoutablePresence(presence: PresenceStatus): boolean {
  return presence === ROUTABLE_PRESENCE;
}

export function computeCapacityStatus(
  currentLoad: number,
  maxLoad: number,
): CapacityStatus {
  return currentLoad >= maxLoad ? 'FULL' : 'OK';
}

export function isFull(
  state: Pick<AgentState, 'currentLoad' | 'maxLoad'>,
): boolean {
  return state.currentLoad >= state.maxLoad;
}

/**
 * The four independent gates that decide whether an agent may receive a NEW
 * interaction (§2.1). workStatus is intentionally NOT a gate — an IN_CHAT agent
 * keeps receiving chats until FULL.
 *
 * This must be mirrored atomically inside the Redis Lua reserve scripts; this
 * function is the single source of truth the scripts are derived from.
 */
export function isEligibleForRouting(
  state: Pick<
    AgentState,
    | 'presenceStatus'
    | 'connectionStatus'
    | 'routingStatus'
    | 'currentLoad'
    | 'maxLoad'
  >,
): boolean {
  return (
    state.presenceStatus === 'AVAILABLE' &&
    state.connectionStatus === 'CONNECTED' &&
    state.routingStatus === 'ACCEPTING' &&
    state.currentLoad < state.maxLoad
  );
}

/** The open-interaction flags that `deriveWorkStatus` reduces to one label. */
export interface OpenInteractions {
  call?: boolean;
  chat?: boolean;
  ticket?: boolean;
  email?: boolean;
  wrapUp?: boolean;
}

/** Which flag makes each WorkStatus true. IDLE is the fallthrough, so it has none. */
const WORK_STATUS_INTERACTION: Record<
  WorkStatus,
  keyof OpenInteractions | null
> = {
  IN_CALL: 'call',
  IN_CHAT: 'chat',
  IN_TICKET: 'ticket',
  IN_EMAIL: 'email',
  WRAP_UP: 'wrapUp',
  IDLE: null,
};

/**
 * Reduce concurrent open interactions to a single display label (§2.4).
 * NOTE: priority-max is for display only — do NOT use it for analytics; per-type
 * durations come from `interaction_segments` (gap D).
 *
 * Iterates WORK_STATUS_PRIORITY rather than restating the order as an if-chain.
 * The chain was a second, silent copy of the same ranking: editing the documented
 * constant changed nothing, so the two could disagree with no signal at all.
 */
export function deriveWorkStatus(
  openInteractions: OpenInteractions,
): WorkStatus {
  for (const status of WORK_STATUS_PRIORITY) {
    const flag = WORK_STATUS_INTERACTION[status];
    if (flag && openInteractions[flag]) return status;
  }
  return 'IDLE';
}

// Legacy Interop (3-axis model in agent-presence.ts)
//
// The existing service/gateway/frontend speak the legacy lowercase intent model
// `available | busy | away | offline`. These adapters let the new model coexist
// during migration:  busy ⇔ AVAILABLE + NOT_ACCEPTING (§1.2). The richer
// BREAK/MEETING/TRAINING presences all collapse to legacy `away` (lossy — the
// segment log retains the precise value).

export type LegacyIntentStatus = 'available' | 'busy' | 'away' | 'offline';

/** Map the canonical (presence, routing) pair down to the legacy intent. */
export function toLegacyIntent(
  presence: PresenceStatus,
  routing: RoutingStatus,
): LegacyIntentStatus {
  if (presence === 'OFFLINE') return 'offline';
  if (presence === 'AVAILABLE') {
    return routing === 'ACCEPTING' ? 'available' : 'busy';
  }
  // AWAY / BREAK / MEETING / TRAINING
  return 'away';
}

/** Map a legacy intent up to the canonical (presence, routing) pair. */
export function fromLegacyIntent(intent: LegacyIntentStatus): {
  presenceStatus: PresenceStatus;
  routingStatus: RoutingStatus;
} {
  switch (intent) {
    case 'available':
      return { presenceStatus: 'AVAILABLE', routingStatus: 'ACCEPTING' };
    case 'busy':
      return { presenceStatus: 'AVAILABLE', routingStatus: 'NOT_ACCEPTING' };
    case 'away':
      return { presenceStatus: 'AWAY', routingStatus: 'NOT_ACCEPTING' };
    case 'offline':
    default:
      return { presenceStatus: 'OFFLINE', routingStatus: 'NOT_ACCEPTING' };
  }
}

/**
 * Display status for the UI badge. Mirrors the legacy `computeDisplayStatus`
 * contract: connection down ⇒ offline; otherwise the legacy intent.
 */
export function computeDisplayStatus(
  presence: PresenceStatus,
  routing: RoutingStatus,
  connection: ConnectionStatus,
): LegacyIntentStatus {
  if (presence === 'OFFLINE' || connection === 'DISCONNECTED') return 'offline';
  return toLegacyIntent(presence, routing);
}
