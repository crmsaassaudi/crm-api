import { AccountMapper } from './account.mapper';
import { Account } from '../../../../domain/account';

/**
 * The mapper is the whitelist.
 *
 * `BaseDocumentRepository.update` writes only the fields `toPersistence` produces, so a
 * field the mapper does not know about cannot be updated — the write succeeds, returns
 * 200, and the value is silently dropped. That is how the derived identity keys broke:
 * `AccountsService.update` recomputed `nameKey` / `websiteDomain` / `taxIdKey` on every
 * PATCH and the mapper discarded all three, so renaming a company left it matching on
 * its old name forever. Create was unaffected (it bypasses the mapper), which is why the
 * gap looked like it worked.
 *
 * These tests pin the round trip for every field a write path depends on.
 */
describe('AccountMapper round trip', () => {
  const domain = (overrides: Partial<Account> = {}): Account =>
    ({
      id: '60d0fe4f5311236168a109ca',
      tenantId: '60d0fe4f5311236168a109cc',
      name: 'Acme Corp',
      ...overrides,
    }) as Account;

  it('should carry the derived identity keys to persistence', () => {
    const persisted = AccountMapper.toPersistence(
      domain({
        nameKey: 'acme',
        websiteDomain: 'acme.com',
        taxIdKey: '012345678',
      }),
    );

    expect(persisted.nameKey).toBe('acme');
    expect(persisted.websiteDomain).toBe('acme.com');
    expect(persisted.taxIdKey).toBe('012345678');
  });

  it('should carry an EMPTY identity key, which is a real value', () => {
    // '' is how "this account no longer has a usable key" is recorded. Copying only
    // truthy values would leave the previous key in place, so clearing a website would
    // keep the account matching on the domain it no longer has.
    const persisted = AccountMapper.toPersistence(
      domain({ websiteDomain: '' }),
    );
    expect(persisted.websiteDomain).toBe('');
  });

  it('should omit identity keys the caller did not set', () => {
    // A PATCH that touches only `industry` must not blank the keys: the repository
    // whitelists by payload key, and an explicit undefined would still be filtered,
    // but the mapper must not invent a value either.
    const persisted = AccountMapper.toPersistence(domain());
    expect(persisted.nameKey).toBeUndefined();
    expect(persisted.websiteDomain).toBeUndefined();
    expect(persisted.taxIdKey).toBeUndefined();
  });

  it('should carry orgUnitId, including an explicit null', () => {
    // orgUnitId is a data-visibility axis. Dropping it here would make "move this
    // account to another org unit" a silent no-op.
    expect(
      AccountMapper.toPersistence(domain({ orgUnitId: 'unit1' })).orgUnitId,
    ).toBe('unit1');
    expect(
      AccountMapper.toPersistence(domain({ orgUnitId: null })).orgUnitId,
    ).toBeNull();
  });

  it('should only emit __v when the caller supplied a version', () => {
    // `update()` turns a present `__v` into an optimistic-concurrency filter. An
    // ordinary PATCH must not start failing a check nobody asked for.
    expect((AccountMapper.toPersistence(domain()) as any).__v).toBeUndefined();
    expect(
      (AccountMapper.toPersistence(domain({ version: 4 })) as any).__v,
    ).toBe(4);
  });

  it('should read the identity keys, org unit and version back out', () => {
    const mapped = AccountMapper.toDomain({
      _id: '60d0fe4f5311236168a109ca',
      tenantId: '60d0fe4f5311236168a109cc',
      name: 'Acme Corp',
      nameKey: 'acme',
      websiteDomain: 'acme.com',
      taxIdKey: '012345678',
      orgUnitId: 'unit1',
      __v: 3,
    } as any);

    expect(mapped.nameKey).toBe('acme');
    expect(mapped.websiteDomain).toBe('acme.com');
    expect(mapped.taxIdKey).toBe('012345678');
    expect(mapped.orgUnitId).toBe('unit1');
    // Merge reads this to detect a concurrent edit; undefined would make the check
    // pass vacuously.
    expect(mapped.version).toBe(3);
  });

  it('should normalise a missing org unit to null rather than undefined', () => {
    // The scope filter matches on `orgUnitId`, and a record with no unit must read as
    // "unassigned" consistently whether or not the field was ever written.
    const mapped = AccountMapper.toDomain({
      _id: '60d0fe4f5311236168a109ca',
      name: 'Acme',
    } as any);
    expect(mapped.orgUnitId).toBeNull();
  });
});
