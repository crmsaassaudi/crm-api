/**
 * Soft-delete normalization helpers.
 *
 * The codebase has three flavours of soft delete:
 *   1. `deletedAt: Date | null`   — contacts, deals, tickets, tasks, accounts
 *   2. `isDeleted: boolean`       — channels, channel-config
 *   3. `inTrash: boolean`         — historical channels and some integrations
 *
 * Full normalization (rename schema fields + data migration) is a separate
 * project. This module gives callers a single function to test "is this
 * document soft-deleted?" so downstream code (UI filters, exports,
 * automation triggers) doesn't have to handle each flavour itself.
 *
 * Use `excludeSoftDeletedQuery()` to extend a Mongo filter with the right
 * predicate for whichever shape the collection uses.
 */

export type AnyDoc = Record<string, any>;

/** True if the document is considered soft-deleted under any convention. */
export function isSoftDeleted(doc: AnyDoc | null | undefined): boolean {
  if (!doc) return false;
  if (doc.deletedAt != null) return true;
  if (doc.isDeleted === true) return true;
  if (doc.inTrash === true) return true;
  return false;
}

/**
 * Convention used by a collection. Pick once at the schema level and
 * pass into queries that need to filter out deleted docs.
 */
export type SoftDeleteConvention = 'deletedAt' | 'isDeleted' | 'inTrash';

/**
 * Mongo filter snippet that excludes soft-deleted documents for the given
 * convention. Use spread into your filter:
 *
 *   const filter = {
 *     tenantId,
 *     ...excludeSoftDeletedQuery('deletedAt'),
 *   };
 */
export function excludeSoftDeletedQuery(
  convention: SoftDeleteConvention,
): Record<string, any> {
  switch (convention) {
    case 'deletedAt':
      return { deletedAt: { $exists: false } };
    case 'isDeleted':
      return { $or: [{ isDeleted: { $exists: false } }, { isDeleted: false }] };
    case 'inTrash':
      return { $or: [{ inTrash: { $exists: false } }, { inTrash: false }] };
  }
}

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

/** Update payload that restores a soft-deleted document. */
export function restoreUpdate(
  convention: SoftDeleteConvention,
): Record<string, any> {
  switch (convention) {
    case 'deletedAt':
      return { $unset: { deletedAt: '' } };
    case 'isDeleted':
      return { $set: { isDeleted: false }, $unset: { deletedAt: '' } };
    case 'inTrash':
      return { $set: { inTrash: false }, $unset: { deletedAt: '' } };
  }
}
