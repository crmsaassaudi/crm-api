// ─── Work Status derivation (pure) ──────────────────────────────────────────
//
// workStatus is system-derived from the set of interactions an agent currently
// has open, collapsed to a single display label by priority (§2.4):
//
//   IN_CALL > IN_CHAT > IN_TICKET > IN_EMAIL > WRAP_UP > IDLE
//
// IMPORTANT (gap D): this single label is for display/segments only. Per-channel
// analytics come from `interaction_segments` (overlap allowed), NOT from this.
// ─────────────────────────────────────────────────────────────────────────────

import { WorkStatus } from './presence-state';

export type InteractionType = 'chat' | 'ticket' | 'email' | 'call';

export const INTERACTION_TYPES: readonly InteractionType[] = [
  'chat',
  'ticket',
  'email',
  'call',
];

/**
 * The open-interactions record stored in Redis per agent.
 * `open` maps a stable key (`${type}:${refId}`) → start time (ms), so duplicate
 * opens of the same interaction are idempotent and we can derive per-interaction
 * durations on close.
 */
export interface WorkRecord {
  open: Record<string, number>;
  /** WRAP_UP grace window end (ms) after the last interaction closed. */
  wrapUpUntilMs?: number;
}

export const interactionKey = (type: InteractionType, refId: string): string =>
  `${type}:${refId}`;

export const interactionTypeOf = (key: string): InteractionType =>
  key.slice(0, key.indexOf(':')) as InteractionType;

/** Does the agent have ≥1 open interaction of the given type? */
function hasType(open: Record<string, number>, type: InteractionType): boolean {
  return Object.keys(open).some((k) => interactionTypeOf(k) === type);
}

/**
 * Collapse the open-interactions record to a single workStatus label, honouring
 * the WRAP_UP grace window when nothing is open.
 */
export function computeWorkStatus(
  record: WorkRecord,
  nowMs: number,
): WorkStatus {
  const { open, wrapUpUntilMs } = record;
  if (hasType(open, 'call')) return 'IN_CALL';
  if (hasType(open, 'chat')) return 'IN_CHAT';
  if (hasType(open, 'ticket')) return 'IN_TICKET';
  if (hasType(open, 'email')) return 'IN_EMAIL';
  if (wrapUpUntilMs !== undefined && nowMs < wrapUpUntilMs) return 'WRAP_UP';
  return 'IDLE';
}

/** True when no interaction of any type is open. */
export function isAllClosed(record: WorkRecord): boolean {
  return Object.keys(record.open).length === 0;
}
