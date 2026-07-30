# PR: Contact Core Safety, Identity Consistency, and Lifecycle Projection

## Summary

This PR hardens the Contact domain's destructive and identity-sensitive write paths.
It deliberately does **not** introduce the external search or analytical warehouse
needed for 100M-contact search/reporting; those require a separate infrastructure
decision and PR.

The change delivers:

- durable, recoverable Contact merge sagas;
- exact-record unmerge instead of collection-wide reversal;
- transactional Contact/identity writes for REST create/update;
- normalized identity projection for imported contacts;
- one unconditional exact email/phone uniqueness invariant;
- optimistic locking for all ordinary Contact updates;
- an append-only lifecycle transition projection;
- bounded embedded lifecycle history;
- migration commands and an operator runbook.

## Why

The previous merge ledger stored only `{ collection: count }`. During unmerge, any
non-zero collection count caused every current reference from the survivor to be
moved to the restored Contact. That could steal:

- records that belonged to the survivor before merge;
- records created for the survivor after merge;
- unrelated array associations.

Merge also moved child records before creating its ledger and swallowed individual
collection failures. A crash or optimistic-lock conflict could therefore leave a
partially merged graph without an exact repair receipt.

Identity data had a second consistency boundary:

- Contact arrays were committed first;
- `contact_identities` synchronized afterward and swallowed failures;
- imports bypassed identity synchronization;
- non-strict upsert could change an existing identity's `contactId`;
- tenant uniqueness toggles promised behavior contradicted by the database unique
  index.

Lifecycle history was an unbounded embedded array and therefore a long-term Contact
document-size risk.

## Architecture changes

### 1. Merge as a durable saga

`contact_merges` now stores:

- `status`: `preparing`, `reparenting`, `completed`, `failed`,
  `compensating`, `compensated`, `reverting`, or `reverted`;
- `failureReason`;
- `moveJournal[]`, keyed by collection, field, reference kind, and exact document IDs;
- array pre-images indicating whether the survivor was already associated;
- paired-row disposition indicating conflict-driven soft deletion.

Execution order:

```text
load + authorize pair
  -> calculate survivorship
  -> discover exact reference set
  -> persist PREPARING ledger
  -> mark REPARENTING
  -> mutate only journaled IDs
  -> optimistic survivor update
  -> soft-delete loser
  -> mark COMPLETED
  -> audit/activity/cache invalidation
```

Reference failures now fail the saga and persist `FAILED`; they are no longer logged
and converted into a successful zero count.

### 2. Safe unmerge and recovery

Unmerge:

- rejects legacy count-only ledgers;
- touches only exact journal IDs;
- restores an array's survivor link only when it existed before merge;
- revives paired relationship/affiliation rows suppressed by conflict handling;
- is stateful and idempotent.

Failed saga recovery:

```http
POST /v1/contacts/merges/{mergeId}/recover
Permission: contacts:delete
```

Recovery reverses exact journal entries, restores the loser when necessary, and moves
the saga to `compensated`. Repeating it is safe.

Synchronous merges are capped at 10,000 total journal entries. Larger merges require
a future chunked background saga rather than a potentially oversized Mongo document.

### 3. Transactional normalized identities

REST create/update now synchronize `contact_identities` inside the same Mongo session
as the Contact and automation outbox.

Strict synchronization uses `insertOne`, not identity-key upsert. A concurrent owner
therefore produces a unique-index conflict and aborts the transaction instead of
changing the existing identity's `contactId`.

Non-strict projection upserts include `contactId` in the filter, preventing imports or
repair jobs from stealing another Contact's identity.

Exact identity uniqueness is now unconditional across:

- Mongo unique index;
- REST preflight;
- strict transactional synchronization;
- import job settings snapshot;
- frontend Settings representation.

Shared household identities require an explicit shared-identity model in a future PR;
they are not represented by allowing two owners of one exact key.

### 4. Import projection hook

The shared import engine now exposes `afterBatchWrite`. Contact import uses it to load
successfully persisted Contacts and reconcile their normalized identities.

Failed rows are excluded. Dry runs do not write projections.

### 5. Optimistic locking

Ordinary `PATCH /contacts/:id` now uses the Contact version read at the start of the
command. Concurrent writes return `409 Conflict` instead of silently replacing identity
arrays or custom-field maps.

### 6. Lifecycle transition projection

New collection: `contact_stage_transitions`.

Properties:

- tenant/contact keys;
- from/to stage;
- event time and actor;
- reason, direction, and skipped stages;
- stable unique event ID.

Indexes:

- `(tenantId, contactId, occurredAt desc, _id desc)`;
- unique `(tenantId, eventId)`.

The embedded `stageHistory[]` remains temporarily for compatibility but is capped at
the latest 100 transitions. Timeline reads prefer the append-only projection and fall
back to embedded history until backfill completes.

## API changes

### Added

```http
POST /v1/contacts/merges/{mergeId}/recover
```

### Behavior changes

- Contact create/update can return `409` on an exact identity race.
- Contact update can return `409` on a concurrent version change.
- Legacy merge rows without `moveJournal` cannot be automatically unmerged.
- Merge requests with more than 10,000 reference journal entries return `400`.

No existing response fields were removed.

## Data migration

No destructive schema migration is performed on deploy.

Run in this order:

```bash
npm run check:contact-identity-drift
npm run backfill:contact-identities -- --dry-run
# resolve collisions through merge
npm run backfill:contact-identities -- --skip-conflicts

npm run backfill:contact-stage-transitions -- --dry-run
npm run backfill:contact-stage-transitions
```

Detailed instructions:
`docs/runbooks/contact-domain-migration.md`.

## Compatibility

- Contact email/phone arrays remain populated for existing readers.
- `contact.accountId` remains the compatibility primary-affiliation projection.
- Timeline endpoint contract is unchanged.
- Existing merge history remains readable.
- Legacy count-only merge rows fail closed on unmerge; no unsafe automatic conversion
  is attempted.

## Security

- Recovery requires `contacts:delete`.
- Every raw reference mutation includes tenant scope and exact IDs.
- Identity conflicts do not reveal identity values beyond the existing conflict API.
- Failed saga reasons are truncated and must not contain Contact snapshots/PII.
- Soft-deleted identity reservations cannot route an inbound conversation to a deleted
  Contact.

## Observability

Monitor non-terminal merge states:

```javascript
db.contact_merges.aggregate([
  {
    $match: {
      status: {
        $in: ["preparing", "reparenting", "failed", "compensating", "reverting"]
      }
    }
  },
  { $group: { _id: "$status", count: { $sum: 1 } } }
])
```

Alert on:

- any `failed` merge older than 5 minutes;
- any transitional state older than the Redis lock TTL;
- identity drift above zero after migration;
- lifecycle projection lag or listener errors.

## Rollout

1. Deploy API schema/code.
2. Verify new indexes.
3. Run dry-run migrations.
4. Resolve identity collisions.
5. Run live migrations.
6. Deploy the companion Web change that locks obsolete uniqueness toggles.
7. Monitor merge states and identity drift for 24 hours.
8. Enable recovery only for administrators initially.

## Rollback

Application rollback is safe because fields/collections are additive.

Do not drop:

- `moveJournal` from merge records;
- `contact_stage_transitions`;
- `contact_identities`.

Older application versions will ignore the new fields. If rolling back after new merges
have occurred, do not use the older unmerge implementation because it is collection
wide and unsafe.

## Verification

Executed locally:

- Contact Jest suites: **226 passed, 0 failed**.
- Focused changed-path suites: **75 passed, 0 failed**.
- API TypeScript `--noEmit`: passed.
- API ESLint on changed files: passed.
- Web TypeScript `--noEmit`: passed.
- Web ESLint on companion file: passed.

The standard API `npm run build` pre-step could not delete an existing
`dist/tsconfig.tsbuildinfo` because another Windows process held the file. Direct
TypeScript validation passed.

## Deferred intentionally

The following belong in separate architecture/infra PRs:

1. External contact search at 100M scale:
   - Atlas Search or OpenSearch selection;
   - multilingual analyzers;
   - tenant/ACL filter tokens;
   - index rebuild and cutover.
2. 100M-scale reporting:
   - ClickHouse or managed warehouse selection;
   - event-fed fact tables;
   - late-arrival/deletion semantics;
   - OLTP fallback thresholds.
3. Fully materialized cross-module timeline:
   - events from tickets, deals, tasks, conversations, notes, and emails;
   - one global seek cursor;
   - cold-tier archival.
4. Chunked asynchronous merge for more than 10,000 references.
5. Probabilistic duplicate clusters/workbench.

These are excluded to keep this PR reversible and infrastructure-neutral.

## Companion Web change

Repository: `crm-web`

File:
`src/features/settings/ui/object-manager/AdvancedContactSettingsPage.tsx`

The exact email/phone uniqueness switches are rendered enabled and disabled because
the backend/database invariant is unconditional. This is a separate PR only because
the frontend is a separate Git repository.

## Reviewer checklist

- [ ] Merge journal is written before the first child mutation.
- [ ] Every compensation filter includes exact IDs.
- [ ] Array compensation preserves pre-existing survivor associations.
- [ ] Paired conflicts are recoverable.
- [ ] Legacy unmerge fails closed.
- [ ] Identity strict mode cannot overwrite another owner.
- [ ] Contact and identity writes share the same session.
- [ ] Import excludes failed rows from identity projection.
- [ ] Embedded lifecycle history is bounded.
- [ ] Backfill is idempotent and supports dry-run.
- [ ] Search/reporting infrastructure is not accidentally introduced here.
