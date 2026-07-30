/**
 * Soft-delete normalization helpers.
 *
 * The codebase has three flavours of soft delete:
 *   1. `deletedAt: Date | null`   — contacts, deals, tickets, tasks, accounts
 *   2. `isDeleted: boolean`       — channels, channel-config
 *   3. `inTrash: boolean`         — historical channels and some integrations
 *
 * Full normalization (rename schema fields + data migration) is a separate project. What
 * remains here is the WRITE side for the non-`deletedAt` conventions, which is all anything
 * actually uses (`email-label.service` marks labels with `isDeleted`).
 *
 * Reading is not this module's job any more: for `deletedAt` collections it belongs to
 * `BaseDocumentRepository`, which derives soft-delete support from the schema and owns
 * `remove`, `restore` and `findDeleted`. See the note at the foot of this file for why the
 * read helpers were removed rather than kept for convenience.
 */

/**
 * Convention used by a collection. Pick once at the schema level and
 * pass into queries that need to filter out deleted docs.
 */
export type SoftDeleteConvention = 'deletedAt' | 'isDeleted' | 'inTrash';

/** Update payload that marks a document as soft-deleted. */
export function softDeleteUpdate(
  convention: SoftDeleteConvention,
  now: Date = new Date(),
): Record<string, any> {
  switch (convention) {
    case 'deletedAt':
      return { deletedAt: now };
    case 'isDeleted':
      return { isDeleted: true, deletedAt: now };
    case 'inTrash':
      return { inTrash: true, deletedAt: now };
  }
}

// Removed: `isSoftDeleted`, `excludeSoftDeletedQuery` and `restoreUpdate`.
//
// None had a caller, and `excludeSoftDeletedQuery('deletedAt')` returned
// `{ deletedAt: { $exists: false } }` — the predicate this codebase deliberately moved
// away from. `restore()` UNSETS the field, so `$exists: false` and `deletedAt: null` agree
// today; but a row written with an explicit null (a `default: null` prop, a legacy
// importer) reads as DELETED under `$exists: false` and as live under `null`. Five
// repositories were fixed to use `null` for exactly that reason, and a shared helper
// offering the other convention is how that decision gets quietly reversed by the next
// person who reaches for a shared helper.
//
// `deletedAt` filtering now lives in ONE place — `BaseDocumentRepository` derives it from
// the schema (`remove`, `restore`, `findDeleted`) — which is the architectural answer this
// module was reaching for. `restoreUpdate` in particular duplicated
// `BaseDocumentRepository.restore`.
