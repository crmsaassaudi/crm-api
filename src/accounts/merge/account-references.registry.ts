import {
  EntityReference,
  ReferenceKind as EntityReferenceKind,
  buildReferenceFilter,
  buildReparentUpdate,
  mergeReferences,
} from '../../common/references/entity-reference';

/**
 * Every place in the database that references an Account.
 *
 * The sibling of `contacts/contact-references.registry.ts`, and still deliberately its own
 * TABLE rather than rows in a shared one: the two have different members and different
 * policies, and merging the tables would put indirection between "what happens to a deal
 * when I merge its account" and its answer — the exact question these files exist to make
 * obvious.
 *
 * The MECHANICS are shared (`common/references/entity-reference.ts`). That distinction is
 * the whole design: policy per domain, execution once. This file originally carried its own
 * copy of the kinds and query builders, which was the right call at two registries and the
 * wrong one at five.
 *
 * Adding a collection that references accounts means adding one entry here. Its spec
 * asserts each entry against the live schema, because these collection names are strings
 * and nothing else type-checks them.
 */

/**
 * The `activity_logs.targetType` value that means "this row belongs to an account".
 *
 * Exported as a constant, and imported by everything that reads or writes account
 * activity, because `targetType` is a free-form string with no shared vocabulary:
 * contacts write `'contact'`, deals write `'Deal'`, tickets write `'ticket'`. Any
 * writer that guesses a different casing produces rows that the timeline query never
 * returns and that this registry never re-parents on merge — invisible in both
 * directions, with nothing to fail.
 */
export const ACCOUNT_ACTIVITY_TARGET_TYPE = 'account';

/**
 * Kinds and policies come from `common/references/entity-reference.ts`.
 *
 * This file defined its own copy first, deliberately, when there were only two registries
 * and folding them together would have hidden the answer behind indirection. With five,
 * the mechanics are shared and only the TABLE below is local — which is the part worth
 * reading anyway.
 *
 * The aliases keep every existing import working.
 */
export type AccountReferenceKind = EntityReferenceKind;
export type AccountReference = EntityReference;

export const ACCOUNT_REFERENCES: readonly AccountReference[] = [
  {
    collection: 'contacts',
    field: 'accountId',
    kind: 'objectId',
    label: 'contacts',
    onMerge: 'reparent',
    // A person is not deleted because their employer's record was. `accountId` is
    // mirrored from the primary affiliation, so detaching keeps the two consistent.
    onPurge: 'detach',
  },
  {
    collection: 'account_contact_relations',
    field: 'accountId',
    kind: 'objectId',
    // Unique per (contact, account): if both accounts employ the same contact, the
    // loser's affiliation row is redundant rather than mergeable.
    pairedWith: { otherField: 'contactId', discriminantFields: [] },
    label: 'contact affiliations',
    onMerge: 'reparent',
    // An affiliation is meaningless without the company end of it.
    onPurge: 'cascade',
  },
  {
    collection: 'deals',
    field: 'accountId',
    kind: 'objectId',
    label: 'deals',
    onMerge: 'reparent',
    // Revenue must never disappear because a company record was tidied up.
    onPurge: 'detach',
  },
  {
    collection: 'tickets',
    field: 'accountId',
    kind: 'objectId',
    label: 'tickets',
    onMerge: 'reparent',
    onPurge: 'detach',
  },
  {
    collection: 'activity_logs',
    field: 'targetId',
    kind: 'discriminatedString',
    discriminator: {
      field: 'targetType',
      value: ACCOUNT_ACTIVITY_TARGET_TYPE,
    },
    label: 'timeline entries',
    onMerge: 'reparent',
    onPurge: 'cascade',
  },
  {
    collection: 'audit_logs',
    field: 'entityId',
    kind: 'discriminatedString',
    discriminator: { field: 'entityType', value: 'ACCOUNT' },
    label: 'audit entries',
    // The audit trail records what happened to a specific account id. Rewriting it
    // would falsify history; the merge is audited in its own right instead.
    onMerge: 'keep',
    onPurge: 'keep',
  },
] as const;

/** References a merge must move onto the surviving account. */
export const ACCOUNT_MERGE_REFERENCES = mergeReferences(ACCOUNT_REFERENCES);

/**
 * The query builders, under their original names.
 *
 * Aliases rather than re-exports because the names differ: merge, purge and this file's
 * spec all call `buildAccountReferenceFilter`. One implementation, three call sites, no
 * renaming churn.
 */
export const buildAccountReferenceFilter = buildReferenceFilter;
export const buildAccountReparentUpdate = buildReparentUpdate;
