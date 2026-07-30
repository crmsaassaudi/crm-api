/**
 * Decides whether a growth-trend request can be answered from
 * `contact_daily_metrics` instead of scanning `contacts`.
 *
 * This is the correctness boundary of the whole rollup. A wrong `true` returns
 * numbers that look plausible and are silently incorrect — far worse than the slow
 * query it replaced. So it is a pure function with no I/O, it fails CLOSED (any
 * condition it does not explicitly understand means "use the live query"), and it
 * returns the reason so a fallback is observable rather than invisible.
 */

export type RollupRefusalReason =
  | 'filter:sourceId'
  | 'filter:stageId'
  | 'filter:channel'
  | 'filter:isVIP'
  | 'filter:includeDeleted'
  | 'abac-predicate'
  | 'visibility-not-evaluated'
  | 'range-not-covered'
  | 'disabled';

export interface RollupDecision {
  canServe: boolean;
  reason?: RollupRefusalReason;
}

export interface RollupRequestShape {
  /** Filters present on the request, by the DTO's field names. */
  sourceId?: unknown;
  stageId?: unknown;
  channel?: unknown;
  isVIP?: unknown;
  includeDeleted?: unknown;
}

export interface RollupContextShape {
  /**
   * `null` = unrestricted, `string[]` = restricted to these owners,
   * `undefined` = visibility was never evaluated (a system path).
   */
  visibleOwnerIds: string[] | null | undefined;
  /** A compiled ABAC row predicate, if one applies to this resource. */
  hasAbacFilter: boolean;
  /** Latest day the rollup has computed, `YYYY-MM-DD`, or null when empty. */
  rollupCoveredThrough: string | null;
  /** Last day the request needs, `YYYY-MM-DD`. */
  requestedThrough: string;
  /** Feature flag: false disables the rollup path entirely. */
  enabled: boolean;
}

const ALLOWED = { canServe: true } as const;

const refuse = (reason: RollupRefusalReason): RollupDecision => ({
  canServe: false,
  reason,
});

export function canServeFromRollup(
  request: RollupRequestShape,
  context: RollupContextShape,
): RollupDecision {
  if (!context.enabled) return refuse('disabled');

  // ── Dimensions the rollup does not carry ──
  //
  // `sourceId` and `channel` could be added as dimensions later. `stageId`
  // deliberately cannot: a contact's stage changes over time, so a
  // creation-day bucket keyed by its CURRENT stage would retroactively rewrite
  // history every time someone advanced a lifecycle stage.
  if (request.sourceId) return refuse('filter:sourceId');
  if (request.stageId) return refuse('filter:stageId');
  if (request.channel) return refuse('filter:channel');
  if (request.isVIP !== undefined) return refuse('filter:isVIP');

  // The rollup's `created` count ignores deletion by design, so it cannot express
  // the difference `includeDeleted` makes to the other series.
  if (request.includeDeleted) return refuse('filter:includeDeleted');

  // ── Visibility ──
  //
  // An ABAC predicate is an arbitrary row filter compiled per policy. It cannot be
  // reduced to owner/orgUnit buckets, and guessing would leak rows.
  if (context.hasAbacFilter) return refuse('abac-predicate');

  // `undefined` means no request evaluated visibility — a cron or system caller.
  // The live path treats that as "no predicate"; serving it from the rollup would
  // work, but refusing keeps the rollup strictly a request-path optimisation and
  // avoids a class of surprise in background jobs.
  if (context.visibleOwnerIds === undefined) {
    return refuse('visibility-not-evaluated');
  }

  // ── Freshness ──
  //
  // The rollup is computed nightly, so today's partial day is never in it. Serving
  // a range that extends past what has been computed would silently report zero for
  // the uncovered days — the failure mode that makes a stale rollup dangerous rather
  // than merely stale.
  if (
    context.rollupCoveredThrough === null ||
    context.requestedThrough > context.rollupCoveredThrough
  ) {
    return refuse('range-not-covered');
  }

  return ALLOWED;
}
