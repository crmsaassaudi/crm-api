import { BaseDocumentRepository } from './document-repository.abstract';
import { createClsMock } from '../../test/mocks/cls.mock';

/**
 * C3 regression suite: unowned records (ownerId null/missing) must NOT leak to
 * scoped (non-admin) users. They are only included when the tenant explicitly
 * opts in via includeUnownedInScope. Admins bypass (visibleOwnerIds === null).
 */
class TestRepo extends BaseDocumentRepository<any, any> {
  applyFilter(filter: any = {}) {
    return this.applyTenantFilter(filter);
  }
  protected mapToDomain(doc: any) {
    return doc;
  }
  protected toPersistence(domain: any) {
    return domain;
  }
}

describe('BaseDocumentRepository.applyTenantFilter — unowned scope (C3)', () => {
  const repo = (cls: ReturnType<typeof createClsMock>) =>
    new TestRepo({} as any, cls as any);

  const ownerOr = (filter: any) => filter.$and?.[0]?.$or as any[] | undefined;

  it('adds NO owner filter for an admin (visibleOwnerIds = null)', () => {
    const filter = repo(createClsMock({ visibleOwnerIds: null })).applyFilter();
    expect(filter.$and).toBeUndefined();
  });

  it('adds NO owner filter on the system path (undefined)', () => {
    const filter = repo(
      createClsMock({ visibleOwnerIds: undefined }),
    ).applyFilter();
    expect(filter.$and).toBeUndefined();
  });

  it('restricts a scoped user to visible owners WITHOUT unowned records by default', () => {
    const filter = repo(
      createClsMock({
        visibleOwnerIds: ['u1', 'u2'],
        includeUnownedInScope: false,
      }),
    ).applyFilter();

    const or = ownerOr(filter)!;
    expect(or).toContainEqual({ ownerId: { $in: ['u1', 'u2'] } });
    expect(or).not.toContainEqual({ ownerId: null });
  });

  it('includes unowned records only when the tenant opts in', () => {
    const filter = repo(
      createClsMock({
        visibleOwnerIds: ['u1'],
        includeUnownedInScope: true,
      }),
    ).applyFilter();

    const or = ownerOr(filter)!;
    expect(or).toContainEqual({ ownerId: { $in: ['u1'] } });
    expect(or).toContainEqual({ ownerId: null });
  });

  it('preserves an existing caller filter alongside the scope clause', () => {
    const filter = repo(
      createClsMock({ visibleOwnerIds: ['u1'], includeUnownedInScope: false }),
    ).applyFilter({ deletedAt: { $exists: false } });

    expect(filter.deletedAt).toEqual({ $exists: false });
    expect(ownerOr(filter)).toContainEqual({ ownerId: { $in: ['u1'] } });
  });
});
