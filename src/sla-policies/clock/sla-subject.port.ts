import type { SlaSubjectType } from './sla-clock.schema';

/** What a clock needs to know about the thing it is measuring. */
export interface SlaSubjectContext {
  /**
   * Selects a target inside the chosen policy: the ticket priority for a
   * ticket, the conversation segment for a conversation. `null` means only the
   * policy's catch-all target applies.
   */
  segment: string | null;
}

/**
 * The projection written back onto the subject after a clock changes.
 *
 * Partial, and read key-by-key: an absent key means "leave it alone", an
 * explicit `null` means "clear it". The engine sends deadlines and the breach
 * flag on different occasions, so a port that wrote every field on every call
 * would blank the deadlines each time a policy id was recorded.
 */
export interface SlaSubjectProjection {
  firstResponseDueAt?: Date | null;
  resolutionDueAt?: Date | null;
  /** A date marks a breach; `null` clears the flag, which only reopen does. */
  breachedAt?: Date | null;
  policyId?: string | null;
}

/**
 * How the clock engine reaches a subject it does not own.
 *
 * The engine reads one attribute (which target applies) and writes one
 * projection (the deadlines the list view filters on). Conversations live in
 * omni-inbound and tickets in the tickets module, so importing either into
 * sla-policies would close a dependency cycle — one narrow port per subject
 * type instead. This is what keeps a new subject type an adapter rather than a
 * second engine; see the `SlaClockService` header.
 */
export interface SlaSubjectPort {
  readonly subjectType: SlaSubjectType;

  /** Attributes used to pick a policy target. Null when the subject is gone. */
  loadContext(
    tenantId: string,
    subjectId: string,
  ): Promise<SlaSubjectContext | null>;

  /** Persist the deadlines and breach flag onto the subject record. */
  project(
    tenantId: string,
    subjectId: string,
    projection: SlaSubjectProjection,
  ): Promise<void>;

  /**
   * Record that an agent answered — the business fact, not the SLA artefact.
   *
   * Called before any policy is consulted, because First Response Time has to
   * be measurable in a tenant that has written no SLA policy at all. Optional:
   * a subject that stamps its own first response (the ticket does, atomically,
   * when the reply is posted) has nothing left for the engine to do.
   */
  recordAgentResponse?(
    tenantId: string,
    subjectId: string,
    respondedAt: Date,
    responderId: string | null,
  ): Promise<void>;
}

/** DI token for the array of registered subject ports. */
export const SLA_SUBJECT_PORTS = Symbol('SLA_SUBJECT_PORTS');
