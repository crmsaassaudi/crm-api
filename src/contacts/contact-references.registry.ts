import {
  EntityReference,
  ReferenceKind as EntityReferenceKind,
} from '../common/references/entity-reference';

/**
 * Every place in the database that references a Contact.
 *
 * Why a registry rather than inline queries in each caller: merge, delete-cascade
 * and GDPR erasure all need the same answer to "what points at this contact?",
 * and before this existed each of them had its own partial answer. Merge had
 * none at all — it unioned the two contacts' own arrays and soft-deleted the
 * loser, leaving notes, tickets, deals, tasks, conversations, email bodies, the
 * activity feed and the audit trail still pointing at a contact the UI no longer
 * shows. The data was not deleted; it became unreachable, which is worse,
 * because nothing surfaces as an error.
 *
 * Adding a new collection that references contacts means adding one entry here.
 * The alternative — remembering to touch three services — is how the gap
 * appeared in the first place.
 *
 * Deliberately addressed by raw collection name through the shared Mongoose
 * connection rather than by injecting eight feature modules: ContactsModule
 * already imports Accounts/Deals/Notes/Tasks/Tickets, and pulling in
 * OmniInbound + Channels + AuditLog on top of that creates dependency cycles.
 * The trade-off is that these strings are not type-checked, so
 * `contact-references.registry.spec.ts` asserts each one against the live
 * schema registry.
 */

/**
 * The kinds and policies live in `common/references/entity-reference.ts` now.
 *
 * They were defined here first, then copied into the account registry, then needed by
 * three more domains. Five copies of one type is five places for them to drift — and they
 * did: this file's own filter builder hard-coded `'Contact'` for the `relatedTo` kind,
 * which no shared builder could have known.
 *
 * `ContactReference` stays as an alias so every existing import keeps working, and the
 * builders below stay as named re-exports for the same reason. What is gone is the second
 * implementation of them.
 */
export type ReferenceKind = EntityReferenceKind;
export type ContactReference = EntityReference;

export const CONTACT_REFERENCES: readonly ContactReference[] = [
  {
    collection: 'notes',
    field: 'contactId',
    kind: 'objectId',
    label: 'notes',
    onMerge: 'reparent',
    // A note is written *about* the contact and is meaningless without them.
    onPurge: 'cascade',
  },
  {
    collection: 'tickets',
    field: 'contactId',
    kind: 'objectId',
    label: 'tickets',
    onMerge: 'reparent',
    // A ticket has independent operational value (SLA stats, agent workload),
    // so purging the person must not erase the support record.
    onPurge: 'detach',
  },
  {
    collection: 'deals',
    field: 'contactIds',
    kind: 'objectIdArray',
    label: 'deals',
    onMerge: 'reparent',
    // Revenue must never disappear because a contact was purged.
    onPurge: 'pull',
  },
  {
    collection: 'tasks',
    field: 'relatedTo',
    kind: 'relatedTo',
    // Declared rather than hard-coded. This file's own builder used to embed 'Contact'
    // in the filter, which worked but made the entry unreadable to anything else — and
    // when four more domains grew registries, the shared builder had no way to know
    // which `relatedTo.type` this one meant.
    discriminator: { field: 'type', value: 'Contact' },
    label: 'tasks',
    onMerge: 'reparent',
    onPurge: 'detach',
  },
  {
    collection: 'omni_conversations',
    field: 'contactId',
    kind: 'objectId',
    label: 'conversations',
    onMerge: 'reparent',
    onPurge: 'detach',
  },
  {
    collection: 'email_contents',
    field: 'contactIds',
    kind: 'objectIdArray',
    label: 'email messages',
    onMerge: 'reparent',
    // Mirrors GdprEmailService: drop the id, redact the body only when this was
    // the last contact referencing it.
    onPurge: 'pull',
  },
  // ── Relationships ──
  //
  // Both directions of the person graph are listed separately: the same collection
  // appears twice because a merge has to move rows where the contact is the SUBJECT
  // and rows where it is the OBJECT. Registering only `fromContactId` would leave
  // every relationship pointing AT the merged-away contact dangling — the same
  // class of half-migration the registry exists to prevent.
  {
    collection: 'contact_relations',
    field: 'fromContactId',
    kind: 'objectId',
    pairedWith: {
      otherField: 'toContactId',
      discriminantFields: ['relationType'],
    },
    label: 'relationships (as subject)',
    onMerge: 'reparent',
    // A relationship has no meaning without both people.
    onPurge: 'cascade',
  },
  {
    collection: 'contact_relations',
    field: 'toContactId',
    kind: 'objectId',
    pairedWith: {
      otherField: 'fromContactId',
      discriminantFields: ['relationType'],
    },
    label: 'relationships (as related party)',
    onMerge: 'reparent',
    onPurge: 'cascade',
  },
  {
    collection: 'contact_identities',
    field: 'contactId',
    kind: 'objectId',
    // Unique per (tenant, type, normalisedValue): if both contacts hold the same
    // address the loser's row cannot move onto the survivor, and the survivor
    // already carries the identity.
    pairedWith: {
      otherField: 'normalisedValue',
      discriminantFields: ['type'],
    },
    label: 'identities',
    onMerge: 'reparent',
    // An identity is a way to reach a specific person; with the person purged it
    // reaches nobody, and leaving it would keep reserving the value in the unique
    // index against a contact that no longer exists.
    onPurge: 'cascade',
  },
  {
    collection: 'account_contact_relations',
    field: 'contactId',
    kind: 'objectId',
    // Unique per (contact, account): if both contacts are affiliated with the
    // same company, the loser's row is redundant rather than mergeable.
    pairedWith: {
      otherField: 'accountId',
      discriminantFields: [],
    },
    label: 'company affiliations',
    onMerge: 'reparent',
    onPurge: 'cascade',
  },
  {
    collection: 'activity_logs',
    field: 'targetId',
    kind: 'discriminatedString',
    discriminator: { field: 'targetType', value: 'contact' },
    label: 'timeline entries',
    onMerge: 'reparent',
    onPurge: 'cascade',
  },
  {
    collection: 'audit_logs',
    field: 'entityId',
    kind: 'discriminatedString',
    discriminator: { field: 'entityType', value: 'CONTACT' },
    label: 'audit entries',
    // The audit trail records what happened to a specific record id. Rewriting
    // it to point at the survivor would falsify history — the merge itself is
    // audited instead.
    onMerge: 'keep',
    // Compliance evidence outlives the subject; retention is the audit module's
    // own policy, not the contact lifecycle's.
    onPurge: 'keep',
  },
] as const;

/** References that a merge must move onto the survivor. */
export const MERGE_REFERENCES = CONTACT_REFERENCES.filter(
  (r) => r.onMerge === 'reparent',
);

/**
 * The query builders, unchanged in behaviour and no longer duplicated.
 *
 * Re-exported under their original names because merge, purge and two specs import them
 * from here — renaming the call sites would be churn for its own sake, while keeping two
 * implementations was a real risk.
 */
export {
  buildReferenceFilter,
  buildReparentUpdate,
} from '../common/references/entity-reference';
