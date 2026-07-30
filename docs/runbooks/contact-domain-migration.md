# Contact Domain Migration Runbook

## Deployment order

1. Deploy schemas and application code.
2. Verify the new `contact_merges`, `contact_identities`, and
   `contact_stage_transitions` indexes.
3. Run `npm run check:contact-identity-drift`.
4. Run `npm run backfill:contact-identities -- --dry-run`.
5. Resolve genuine collisions with Contact merge.
6. Run `npm run backfill:contact-identities -- --skip-conflicts`.
7. Run `npm run backfill:contact-stage-transitions -- --dry-run`.
8. Run `npm run backfill:contact-stage-transitions`.
9. Repeat drift checks and compare transition counts.

## Merge recovery

New merge ledgers expose a durable `status`. Recover `failed` rows through:

```http
POST /v1/contacts/merges/{mergeId}/recover
```

The caller needs `contacts:delete`. Recovery is idempotent and only touches exact
document IDs captured before the merge.

Legacy merge rows without `moveJournal` cannot be automatically unmerged. The API
fails closed because collection counts are not a safe compensation receipt.

## Guardrails

- Synchronous merge refuses more than 10,000 total journal entries.
- Do not remove the cap without chunked journal storage and a background saga.
- Do not disable exact email/phone identity uniqueness.
- `stageHistory` is a 100-entry compatibility tail. Full history is stored in
  `contact_stage_transitions`.

## Operational queries

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

db.contact_identities.aggregate([
  { $match: { deletedAt: null } },
  {
    $group: {
      _id: {
        tenantId: "$tenantId",
        type: "$type",
        value: "$normalisedValue"
      },
      count: { $sum: 1 }
    }
  },
  { $match: { count: { $gt: 1 } } }
])
```

## Rollback warning

The schema changes are additive, but do not run an older unmerge implementation after
new merges have occurred. Older unmerge code reverses by collection count rather than
the exact journal and can move unrelated survivor records.
