import { AccountRepository } from './account.repository';

/**
 * The accounts list builder was the only one in the CRM that never filtered
 * `deletedAt` — contacts, deals, tickets and tasks all did. Invisible while
 * `remove()` issued `deleteOne` (the row was gone), and a live defect the moment
 * deletion became a soft delete: the list began listing deleted accounts.
 *
 * `isArchived` was worse than missing: declared on the schema, the domain model and
 * the mapper, writable through the API, and read by nothing. A client could archive
 * an account, receive a 200, and watch it stay in every list.
 *
 * Driven through the private builder because it is the single decision point, and
 * exercising it directly needs no live Mongo.
 */
const repo = new AccountRepository({} as any, {} as any) as any;

const where = (filterOptions?: Record<string, unknown>) =>
  repo.buildListWhere(filterOptions);

describe('account list filter — soft delete', () => {
  it('should exclude soft-deleted accounts', () => {
    expect(where().deletedAt).toBeNull();
  });

  it('should use null rather than $exists so a restored row counts as live', () => {
    // `restore()` UNSETS the field and legacy rows never had it; `deletedAt: null`
    // matches both, `$exists: false` treats a present-but-null field as deleted.
    expect(where().deletedAt).not.toEqual({ $exists: false });
  });

  it('should still exclude deleted accounts when other filters are present', () => {
    const result = where({ search: 'acme' });
    expect(result.deletedAt).toBeNull();
    expect(result.$or).toBeDefined();
  });
});

describe('account list filter — archive', () => {
  it('should exclude archived accounts by default', () => {
    expect(where().isArchived).toEqual({ $ne: true });
  });

  it('should use $ne: true, not false, because most rows have no such field', () => {
    // `isArchived: false` would hide every account created before the field existed —
    // which is nearly all of them.
    expect(where().isArchived).not.toBe(false);
  });

  it('should include archived accounts when asked, so nothing becomes unreachable', () => {
    // Archiving hides from working views; it must not strand the record. Without this
    // an archived account could never be found again to un-archive it.
    expect(where({ includeArchived: true }).isArchived).toBeUndefined();
  });

  it('should keep excluding DELETED accounts even when including archived', () => {
    // The two concepts are independent: "show me archived" is not "show me deleted".
    const result = where({ includeArchived: true });
    expect(result.deletedAt).toBeNull();
  });
});

describe('account list filter — search', () => {
  it('should escape regex metacharacters in the search term', () => {
    const result = where({ search: 'a.*b' });
    expect(result.$or[0].name.$regex).toBe('a\\.\\*b');
  });

  it('should search across the identity-bearing fields', () => {
    const fields = where({ search: 'x' }).$or.map(
      (clause: Record<string, unknown>) => Object.keys(clause)[0],
    );
    expect(fields).toEqual(
      expect.arrayContaining(['name', 'industry', 'phones', 'emails']),
    );
  });
});
