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
    expect(result.$and).toBeDefined();
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
  /** The per-token clauses a search term produced. */
  const clauses = (search: string, canSearchSensitive = false) =>
    (
      where({ search, __canSearchSensitive: canSearchSensitive }).$and ?? []
    ).flatMap((clause: any) => clause.$and ?? [clause]);

  it('should not let a regex metacharacter reach the query at all', () => {
    // Stronger than the escaping this replaces. Tokenisation splits on
    // "not a letter and not a digit", and every regex metacharacter is one, so
    // a token cannot contain one — there is nothing left to escape. (The query
    // builder still escapes, as defence in depth against a future tokeniser
    // that is less strict.)
    for (const clause of clauses('a.*b acme(x)')) {
      expect(clause.searchKeys.$regex).toMatch(/^\^[\p{L}\p{N}]+$/u);
    }
  });

  it('should anchor and stay case-sensitive so the index can serve it', () => {
    // The unanchored `/i` regex this replaces read every live account in the
    // tenant on every keystroke; both properties are what fixed that.
    const expression = clauses('acme')[0].searchKeys;
    expect(expression.$regex).toBe('^acme');
    expect(expression.$options).toBeUndefined();
  });

  it('should not match phone or e-mail without permission to unmask them', () => {
    // They used to be plain `$or` branches, so a masked value doubled as a
    // lookup key for anyone who could see the list at all.
    expect(clauses('+966501234567')[0].$or).toBeUndefined();
  });

  it('should match the masked half when the caller may unmask', () => {
    const fields = clauses('+966501234567', true)[0].$or.map(
      (branch: Record<string, unknown>) => Object.keys(branch)[0],
    );
    expect(fields).toEqual(['searchKeys', 'searchKeysPii']);
  });
});
