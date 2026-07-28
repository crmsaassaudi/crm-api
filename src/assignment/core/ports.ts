import {
  AssignmentObjectType,
  AssignmentStrategy,
} from '../domain/assignment.types';

/**
 * Everything an adapter needs to know about the decision being made. Passed to
 * every port method so adapters stay stateless and safe to share across tenants.
 */
export interface AssignmentScope {
  tenantId: string;
  objectType: AssignmentObjectType;
  /** The record being assigned. Absent for a pre-create decision or a dry run. */
  entityId?: string;
  /**
   * Narrower scope inside the objectType whose settings may override the
   * tenant defaults — today: the omni channel id. Also part of the round-robin
   * key so two channels rotate independently.
   */
  scopeId?: string | null;
  /**
   * Team the decision resolved to. Set by the core after target resolution, so
   * it is present for the reserve/commit calls and absent for pool resolution.
   *
   * Used for the round-robin cursor only — never for the load counter. Rotation
   * is fair within a team; capacity belongs to a person.
   */
  groupId?: string | null;
  /** Durable command identity used by adapters for idempotent commits. */
  commandId?: string | null;
  queuePriority?: number;
  slaDueAt?: Date | null;
}

/**
 * Where candidates come from, and who is allowed to receive work.
 *
 * The record side and the conversation side answer these very differently — a
 * conversation pool is `channel support pool ∩ online agents`, a record pool is
 * simply group membership — which is exactly why this is a port and not a
 * branch inside the core.
 */
export interface CandidateSourcePort {
  /**
   * The ambient pool: who may receive work in this scope at all, before any
   * rule narrows it.
   *
   * `undefined` means "unrestricted — any member of a targeted group qualifies".
   * `[]` means "a restriction was resolved and it admits nobody", which must
   * queue rather than widen. Conflating the two is how a restricted channel
   * ended up assigning to the whole tenant.
   */
  basePool(scope: AssignmentScope): Promise<string[] | undefined>;

  /** Members of the given groups, deduplicated, order-preserving. */
  groupMembers(scope: AssignmentScope, groupIds: string[]): Promise<string[]>;

  /**
   * Whether a group may serve this scope. Used to skip a tier of a rule's
   * escalation chain that the channel does not authorise, instead of failing
   * the whole rule. Default true when not implemented.
   */
  groupMayServe?(scope: AssignmentScope, groupId: string): Promise<boolean>;

  /**
   * Skills per candidate, keyed by userId. Values are skill apiNames.
   * A candidate absent from the map is treated as having no skills.
   */
  skills(
    scope: AssignmentScope,
    candidateIds: string[],
  ): Promise<Map<string, string[]>>;

  /**
   * Apply the availability (presence) axis.
   *
   * `requireOnline: true`  → drop candidates who are not available
   * `requireOnline: false` → keep everyone, online first
   *
   * Optional: the conversation adapter already resolves its base pool as
   * `channel pool ∩ online`, so for it this is a no-op. The record adapter
   * implements it, which is how `omni_presence.requireOnlineForAssignment` —
   * an assignment gate that lived inside the presence settings document —
   * becomes a normal assignment setting.
   */
  filterAvailable?(
    scope: AssignmentScope,
    candidateIds: string[],
    requireOnline: boolean,
  ): Promise<string[]>;
}

/**
 * The load/capacity store, and the only place a candidate is *reserved*.
 *
 * `reserve()` must be atomic and must increment the same counter that
 * `loads()` reads, so two concurrent decisions cannot pick the same person.
 * `release()` undoes exactly one `reserve()`.
 *
 * Both implementations satisfy the same contract, which is the difference from
 * the old code: the record engine had a non-reserving round-robin plus a
 * Mongo count, so concurrent assignments raced and its `compensate()` was
 * optional (and never called).
 */
export interface LoadPort {
  /** Current open-work count per candidate, for ordering and telemetry. */
  loads(
    scope: AssignmentScope,
    candidateIds: string[],
  ): Promise<Map<string, number>>;

  /**
   * Atomically pick and reserve one candidate.
   *
   * @param orderedCandidateIds candidates in the order the strategy prefers
   *   them (already rotated for round-robin). Implementations honour the order
   *   for `round-robin` and ignore it for load-ordered strategies.
   * @param maxCapacity effective per-scope capacity ceiling; implementations
   *   may override it per candidate from their own store.
   * @returns the reserved candidate, or null when nobody is eligible.
   */
  reserve(
    scope: AssignmentScope,
    orderedCandidateIds: string[],
    strategy: AssignmentStrategy,
    maxCapacity: number,
  ): Promise<string | null>;

  /** Undo one reservation. Must be safe to call when nothing was reserved. */
  release(scope: AssignmentScope, candidateId: string): Promise<void>;

  /** Finalize a successful reservation without decrementing durable workload. */
  complete?(scope: AssignmentScope, candidateId: string): Promise<void>;

  /**
   * Who `reserve()` would pick, without reserving anything. Powers the dry run.
   *
   * Optional, but strongly preferred: without it the core has to approximate the
   * choice from `loads()` plus the scope-level capacity, and it cannot see
   * per-candidate capacity overrides — so the dry run and the real decision can
   * disagree about a candidate who is over their personal limit but under the
   * scope default.
   */
  preview?(
    scope: AssignmentScope,
    orderedCandidateIds: string[],
    strategy: AssignmentStrategy,
    maxCapacity: number,
  ): Promise<string | null>;

  /**
   * Reorder candidates so the next round-robin pick comes first.
   *
   * Optional because only round-robin needs it: the load-ordered strategies
   * choose inside the reservation script, where scores are read atomically.
   * An implementation that omits it gets the caller's order unchanged, which
   * degrades round-robin to "first eligible" rather than breaking it.
   */
  rotate?(scope: AssignmentScope, candidateIds: string[]): Promise<string[]>;
}

/**
 * Persisting the outcome.
 *
 * `commit` returns false — rather than throwing — when the write lost a race
 * (someone else claimed the record first). The core then releases the
 * reservation and reports `commitRaceLost`, so a lost race never leaks capacity.
 */
export interface CommitPort {
  commit(
    scope: AssignmentScope,
    assigneeId: string,
    groupId: string | null,
  ): Promise<boolean>;

  /**
   * Record the owning group when there is no assignee, so the record lands in
   * that team's queue instead of a global one. Best-effort by contract:
   * failing to tag a queue must not turn a `queued` outcome into an error.
   */
  park?(scope: AssignmentScope, groupId: string): Promise<void>;

  /** Remove any durable queue projection after a successful assignment. */
  complete?(scope: AssignmentScope): Promise<void>;
}

/**
 * One adapter bundles the three ports for one objectType family.
 */
export interface AssignmentAdapter {
  readonly objectTypes: readonly AssignmentObjectType[];
  readonly candidates: CandidateSourcePort;
  readonly load: LoadPort;
  readonly commit: CommitPort;
}

/** DI token for adapters — registered as a multi-provider. */
export const ASSIGNMENT_ADAPTER = 'ASSIGNMENT_ADAPTER';
