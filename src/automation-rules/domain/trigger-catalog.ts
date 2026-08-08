import { AutomationCrmModule } from '../events/automation-event.payload';

/**
 * The trigger vocabulary, in one place.
 *
 * Every layer that decides what can start a workflow reads this: the DTO enum,
 * the Mongoose enum, the event-listener subscriptions, and the builder through
 * `GET /automation-workflows/capabilities`.
 *
 * Adding a trigger type means adding it here and then making every consumer
 * compile again — which is the point. A capability that exists in one layer only
 * is worse than one that does not exist at all.
 */
export const AUTOMATION_TRIGGER_EVENTS = [
  'record_created',
  'field_updated',
  'score_changed',
  'score_threshold_crossed',
] as const;

export type AutomationTriggerEvent = (typeof AUTOMATION_TRIGGER_EVENTS)[number];

export const AUTOMATION_TRIGGER_OBJECTS = [
  'Lead',
  'Contact',
  'Ticket',
  'Deal',
  'Account',
  'Task',
  'Conversation',
  'Message',
] as const satisfies readonly AutomationCrmModule[];

/**
 * Objects served by omni-inbound rather than a CRM record service.
 *
 * They can trigger a workflow (the bridge re-emits their events), but they are
 * not writable through `CrmRecordUpdateService` and cannot be re-read on a
 * delayed resume, which is why some actions and the wait node are refused on them.
 */
export const OMNI_TRIGGER_OBJECTS: ReadonlySet<string> = new Set([
  'Conversation',
  'Message',
]);
