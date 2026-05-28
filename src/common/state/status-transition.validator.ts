import { BadRequestException } from '@nestjs/common';

/**
 * Generic state machine guard. Each entity that wants to lock down its
 * status transitions can declare a transitions map and call assertTransition.
 *
 * The map shape is: `from -> Set<to>`. `null` (or absent) on the from-key
 * means "no transitions defined" — guard rejects to fail closed.
 *
 * Example for deals:
 *
 *   const DEAL_TRANSITIONS: TransitionMap = {
 *     open:  new Set(['won','lost','open']),
 *     won:   new Set(['won']),           // terminal
 *     lost:  new Set(['lost','open']),   // allow reopen
 *   };
 */

export type TransitionMap = Record<string, ReadonlySet<string>>;

export function assertTransition(
  entity: string,
  transitions: TransitionMap,
  fromStatus: string | undefined,
  toStatus: string | undefined,
): void {
  if (!toStatus) return;
  if (!fromStatus) return; // creation path, not a transition
  if (fromStatus === toStatus) return; // idempotent

  const allowed = transitions[fromStatus];
  if (!allowed) {
    throw new BadRequestException(
      `${entity}: no transitions configured from status "${fromStatus}".`,
    );
  }
  if (!allowed.has(toStatus)) {
    throw new BadRequestException(
      `${entity}: cannot transition from "${fromStatus}" to "${toStatus}".`,
    );
  }
}

// ── Canonical maps for the core entities ────────────────────────────────

/**
 * Deal lifecycle. Custom pipeline stages should still allow moving between
 * non-terminal stages freely, but once a deal is `won` it stays won.
 */
export const DEAL_STATUS_TRANSITIONS: TransitionMap = {
  open: new Set(['open', 'won', 'lost']),
  won: new Set(['won']),
  lost: new Set(['lost', 'open']),
};

/**
 * Ticket lifecycle. `closed` is terminal; `resolved` may be reopened.
 */
export const TICKET_STATUS_TRANSITIONS: TransitionMap = {
  new: new Set(['new', 'open', 'pending', 'resolved', 'closed']),
  open: new Set(['open', 'pending', 'resolved', 'closed']),
  pending: new Set(['pending', 'open', 'resolved', 'closed']),
  resolved: new Set(['resolved', 'closed', 'open']),
  closed: new Set(['closed']),
};

/**
 * Task lifecycle.
 */
export const TASK_STATUS_TRANSITIONS: TransitionMap = {
  todo: new Set(['todo', 'in_progress', 'done', 'cancelled']),
  in_progress: new Set(['in_progress', 'done', 'cancelled', 'todo']),
  done: new Set(['done']),
  cancelled: new Set(['cancelled', 'todo']),
};
