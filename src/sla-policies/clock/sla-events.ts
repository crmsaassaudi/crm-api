import type { SlaSubjectType } from './sla-clock.schema';

/**
 * The one name a breach is published under, for every subject type.
 *
 * It lives next to the engine that emits it rather than in omni's vocabulary,
 * so a new subject type can be added without every consumer importing a name
 * that describes only one of them. Consumers that serve a single subject must
 * filter on `subjectType`.
 */
export const SlaEvents = {
  BREACHED: 'sla.clock.breached',
} as const;

export interface SlaBreachedEvent {
  tenantId: string;
  subjectType: SlaSubjectType;
  subjectId: string;
  clockId: string;
  slaPolicyId: string;
  metric: 'first_response' | 'next_response' | 'resolution';
  cycle: number;
  dueAt: Date;
  breachedAt: Date;
}
