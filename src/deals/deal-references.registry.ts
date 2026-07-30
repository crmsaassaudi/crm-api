import { EntityReference } from '../common/references/entity-reference';

/**
 * Every place in the database that references a Deal.
 *
 * Read this to answer "what happens to X when a deal is purged". The mechanics live in
 * `common/references/entity-reference.ts`; the policies live here, because they are
 * judgements about this domain rather than code.
 */
export const DEAL_REFERENCES: readonly EntityReference[] = [
  {
    collection: 'tickets',
    field: 'dealId',
    kind: 'objectId',
    label: 'tickets',
    onMerge: 'reparent',
    // A support ticket outlives the commercial record it was linked to. Its SLA history
    // and its conversation belong to the customer, not to the deal.
    onPurge: 'detach',
  },
  {
    collection: 'tasks',
    field: 'relatedTo',
    kind: 'relatedTo',
    discriminator: { field: 'type', value: 'Deal' },
    label: 'tasks',
    onMerge: 'reparent',
    // The task is somebody's work item — often already done. Unset the link rather than
    // deleting their record of it.
    onPurge: 'detach',
  },
  {
    collection: 'activity_logs',
    field: 'targetId',
    kind: 'discriminatedString',
    // Capitalised: `DealsController` writes and reads `targetType: 'Deal'`, while
    // contacts use `'contact'` and tickets `'ticket'`. There is no canonical vocabulary
    // for this field, so the registry mirrors what the domain actually writes — guessing
    // the casing would produce a filter that matches nothing and a purge that silently
    // leaves every timeline row behind.
    discriminator: { field: 'targetType', value: 'Deal' },
    label: 'timeline entries',
    onMerge: 'reparent',
    onPurge: 'cascade',
  },
  {
    collection: 'audit_logs',
    field: 'entityId',
    kind: 'discriminatedString',
    discriminator: { field: 'entityType', value: 'DEAL' },
    label: 'audit entries',
    // The audit trail records what happened to a specific id. Rewriting or deleting it
    // would falsify history; the merge and the purge are audited in their own right.
    onMerge: 'keep',
    onPurge: 'keep',
  },
] as const;

/**
 * No `DEAL_MERGE_REFERENCES`.
 *
 * There is no deal merge flow. `onMerge` is declared on each entry because the shared
 * type requires a policy and because the answer should be recorded before somebody needs
 * it — but exporting a derived list with no reader is how a codebase accumulates things
 * that look wired up and are not. Add the export with the merge service that uses it.
 */
