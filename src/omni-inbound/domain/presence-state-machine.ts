// ─── Presence State Machine ──────────────────────────────────────────────────
//
// Pure transition logic for the canonical 4-axis model (presence-state.ts).
// All functions are side-effect free and return a new AgentState plus an
// outcome describing which axes changed (so the service knows which reporting
// segments to close/open in §3). See docs/agent-presence-workforce-spec.md §2.
// ─────────────────────────────────────────────────────────────────────────────

import { AgentState, PresenceStatus, RoutingStatus } from './presence-state';

/** What caused a transition — used for audit logging and segment triggers. */
export type TransitionTrigger =
  | 'agent_manual' // agent clicked a status / Ready in the UI
  | 'supervisor_override' // a supervisor forced the state
  | 'system_login' // fresh session → AVAILABLE + NOT_ACCEPTING
  | 'system_logout' // explicit logout → OFFLINE
  | 'system_connect' // socket (re)connected
  | 'system_disconnect' // all sockets lost (before grace)
  | 'system_reconnect' // reconnected within grace
  | 'system_grace_expired' // grace window elapsed → forced OFFLINE
  | 'system_day_rollover' // midnight cut (§3.2)
  | 'system_work_status'; // system-derived workStatus change (§2.4)

export type TransitionActor = 'agent' | 'system' | 'supervisor';

export interface TransitionContext {
  trigger: TransitionTrigger;
  /** Server time (ms) used to stamp `updatedAtMs`. */
  nowMs: number;
  actor?: TransitionActor;
  /** Tenant setting `omni_presence.restoreAcceptingOnReturn` (§1.2). */
  restoreAcceptingOnReturn?: boolean;
  /**
   * Whether the agent was ACCEPTING the last time it was AVAILABLE. Consulted
   * only when returning to AVAILABLE with `restoreAcceptingOnReturn = true`.
   */
  wasAcceptingBeforeLeave?: boolean;
}

export type ChangedAxis = 'presence' | 'routing';

export interface TransitionResult {
  ok: boolean;
  /** New state when ok; the unchanged input state when !ok. */
  state: AgentState;
  /** Present only when !ok. */
  error?: string;
  /** Axes that actually changed value — drives segment close/open. */
  changed: ChangedAxis[];
}

// ─── Presence transition validity (§2.2 matrix) ──────────────────────────────

/**
 * Is a presence transition allowed?
 *   - From OFFLINE: only → AVAILABLE (login).
 *   - From any online presence: → any online presence, or → OFFLINE but only by
 *     system/supervisor (agents log out, they never pick OFFLINE directly).
 */
export function canTransitionPresence(
  from: PresenceStatus,
  to: PresenceStatus,
  actor: TransitionActor = 'agent',
): boolean {
  if (from === to) return true; // idempotent no-op
  if (from === 'OFFLINE') {
    // Only a login (AVAILABLE) brings an agent out of OFFLINE.
    return to === 'AVAILABLE';
  }
  if (to === 'OFFLINE') {
    // Agents cannot self-select OFFLINE — only logout/timeout/supervisor.
    return actor !== 'agent';
  }
  // online → online is always allowed.
  return true;
}

// ─── Routing interlock when presence changes (§1.2) ──────────────────────────

function routingAfterPresenceChange(
  to: PresenceStatus,
  from: PresenceStatus,
  current: RoutingStatus,
  ctx: TransitionContext,
): RoutingStatus {
  // Non-AVAILABLE presences can never accept work.
  if (to !== 'AVAILABLE') return 'NOT_ACCEPTING';

  // Staying AVAILABLE (idempotent) keeps the existing routing.
  if (from === 'AVAILABLE') return current;

  // Returning to AVAILABLE from BREAK/MEETING/AWAY/TRAINING/OFFLINE:
  // default is NOT_ACCEPTING (agent must press Ready). Auto-restore only when
  // the tenant opts in AND the agent was accepting before leaving (§1.2).
  if (ctx.restoreAcceptingOnReturn && ctx.wasAcceptingBeforeLeave) {
    return 'ACCEPTING';
  }
  return 'NOT_ACCEPTING';
}

// ─── Transitions ─────────────────────────────────────────────────────────────

/** Change the presence axis, applying the routing interlock. */
export function transitionPresence(
  state: AgentState,
  to: PresenceStatus,
  ctx: TransitionContext,
): TransitionResult {
  const actor = ctx.actor ?? 'agent';
  if (!canTransitionPresence(state.presenceStatus, to, actor)) {
    return {
      ok: false,
      state,
      error: `Illegal presence transition ${state.presenceStatus} → ${to} by ${actor}`,
      changed: [],
    };
  }

  const nextRouting = routingAfterPresenceChange(
    to,
    state.presenceStatus,
    state.routingStatus,
    ctx,
  );

  const changed: ChangedAxis[] = [];
  if (to !== state.presenceStatus) changed.push('presence');
  if (nextRouting !== state.routingStatus) changed.push('routing');

  return {
    ok: true,
    state: {
      ...state,
      presenceStatus: to,
      routingStatus: nextRouting,
      updatedAtMs: ctx.nowMs,
    },
    changed,
  };
}

/**
 * Toggle the routing (accept-work) switch. Only valid while the agent is
 * AVAILABLE and CONNECTED — you cannot "accept work" while away/offline.
 */
export function setRouting(
  state: AgentState,
  routing: RoutingStatus,
  ctx: TransitionContext,
): TransitionResult {
  if (state.presenceStatus !== 'AVAILABLE') {
    return {
      ok: false,
      state,
      error: `Cannot set routing=${routing} while presence=${state.presenceStatus}`,
      changed: [],
    };
  }
  if (routing === 'ACCEPTING' && state.connectionStatus !== 'CONNECTED') {
    return {
      ok: false,
      state,
      error: 'Cannot start ACCEPTING while DISCONNECTED',
      changed: [],
    };
  }
  if (routing === state.routingStatus) {
    return { ok: true, state, changed: [] };
  }
  return {
    ok: true,
    state: { ...state, routingStatus: routing, updatedAtMs: ctx.nowMs },
    changed: ['routing'],
  };
}

/**
 * Fresh login. Always lands on AVAILABLE + NOT_ACCEPTING — never directly into
 * ACCEPTING, to avoid routing work to an agent who isn't ready (§2.2, TC04).
 */
export function applyLogin(state: AgentState, nowMs: number): TransitionResult {
  const changed: ChangedAxis[] = [];
  if (state.presenceStatus !== 'AVAILABLE') changed.push('presence');
  if (state.routingStatus !== 'NOT_ACCEPTING') changed.push('routing');
  return {
    ok: true,
    state: {
      ...state,
      presenceStatus: 'AVAILABLE',
      routingStatus: 'NOT_ACCEPTING',
      connectionStatus: 'CONNECTED',
      updatedAtMs: nowMs,
    },
    changed,
  };
}

/**
 * Force OFFLINE (logout, grace-period expiry, or supervisor). Closes routing.
 */
export function forceOffline(
  state: AgentState,
  ctx: TransitionContext,
): TransitionResult {
  const changed: ChangedAxis[] = [];
  if (state.presenceStatus !== 'OFFLINE') changed.push('presence');
  if (state.routingStatus !== 'NOT_ACCEPTING') changed.push('routing');
  return {
    ok: true,
    state: {
      ...state,
      presenceStatus: 'OFFLINE',
      routingStatus: 'NOT_ACCEPTING',
      connectionStatus: 'DISCONNECTED',
      updatedAtMs: ctx.nowMs,
    },
    changed,
  };
}

/**
 * Midnight rollover reset (§3.2). Presence is preserved (the service cuts the
 * segment at the day boundary), but a fresh day never carries ACCEPTING — the
 * agent must re-arm Ready (TC04).
 */
export function applyDayRolloverReset(
  state: AgentState,
  nowMs: number,
): TransitionResult {
  if (state.routingStatus === 'NOT_ACCEPTING') {
    return { ok: true, state, changed: [] };
  }
  return {
    ok: true,
    state: { ...state, routingStatus: 'NOT_ACCEPTING', updatedAtMs: nowMs },
    changed: ['routing'],
  };
}

// ─── Multi-device Last-Write-Wins guard (§1.6) ───────────────────────────────

/**
 * Should an incoming command be dropped as stale? Used to reconcile concurrent
 * commands from multiple devices/tabs: a command whose client timestamp is
 * older than the last applied one is ignored (monotonic guard). The newest
 * intent wins regardless of network-induced arrival order.
 */
export function isStaleCommand(
  incomingClientTs: number,
  lastAppliedClientTs: number | undefined,
): boolean {
  if (lastAppliedClientTs === undefined) return false;
  return incomingClientTs < lastAppliedClientTs;
}
