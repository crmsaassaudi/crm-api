import { EntityReference } from '../common/references/entity-reference';

/**
 * Every place in the database that references a Task.
 *
 * The shortest of the five registries, and worth saying why: a task is a leaf. Nothing
 * hangs off it except its own recurrence chain, so there is little to cascade — which is
 * exactly the kind of claim a registry should make explicitly rather than leave to be
 * inferred from the absence of code.
 */
export const TASK_REFERENCES: readonly EntityReference[] = [
  {
    collection: 'tasks',
    field: 'parentTaskId',
    kind: 'objectId',
    label: 'recurrence instances',
    onMerge: 'reparent',
    // Instances generated from a recurring template point back at it. Purging the
    // template must not delete work someone already did — the instances become
    // standalone tasks and stop generating.
    onPurge: 'detach',
  },
  {
    collection: 'audit_logs',
    field: 'entityId',
    kind: 'discriminatedString',
    discriminator: { field: 'entityType', value: 'TASK' },
    label: 'audit entries',
    onMerge: 'keep',
    onPurge: 'keep',
  },
  // NO activity_logs entry: nothing writes `targetType: 'task'`. Tasks appear in OTHER
  // records' timelines (a contact's feed shows "task created"), and those rows are owned
  // by the contact, not the task — they are cascaded by the contact's registry when the
  // contact is purged, which is the correct owner for them.
] as const;

/**
 * No `TASK_MERGE_REFERENCES`.
 *
 * There is no task merge flow, so no derived export. Same reasoning as the deal registry:
 * the per-entry `onMerge` records the intended answer; a list nothing reads would only
 * look like wiring.
 */
