import { BaseDocumentRepository } from './document-repository.abstract';

/**
 * `remove()` used to be an unconditional `deleteOne`. Six collections — accounts,
 * contacts, deals, notes, tasks, tickets — declare `deletedAt`, filter every read on
 * it, and none of them overrode `remove()`. So each of those domains was written as if
 * deletion were reversible while the method destroyed the row: no recycle bin, an
 * unrecoverable mis-click, orphaned references pointing at the deleted id, and an audit
 * entry recording a soft delete that never happened.
 *
 * These tests pin the behaviour at the base, where it cannot be forgotten per
 * repository, and pin the schema-derived detection — a repository author having to
 * remember to declare "I am soft-delete" is the failure mode that produced the bug.
 */

class TestRepository extends BaseDocumentRepository<any, any> {
  protected mapToDomain(doc: any): any {
    return { id: String(doc?._id), mapped: true };
  }
  protected toPersistence(domain: any): any {
    return domain;
  }
  // The visibility axes are exercised in document-repository.scope.spec.ts; here the
  // tenant filter is a pass-through so the delete semantics are what is under test.
  protected applyTenantFilter(filter: any) {
    return filter;
  }
}

function makeRepo(options: { paths?: string[]; userId?: string } = {}) {
  const paths = new Set(options.paths ?? ['deletedAt', 'updatedById']);
  // Params declared so `mock.calls[0][1]` is typed — the assertions read the update
  // payloads to prove the delete semantics.
  const deleteOne = jest.fn((_filter: any) =>
    Promise.resolve({ deletedCount: 1 }),
  );
  const updateOne = jest.fn((_filter: any, _update: any) =>
    Promise.resolve({ modifiedCount: 1 }),
  );
  const findOneAndUpdate = jest.fn(
    (_filter: any, _update?: any, _opts?: any) => ({
      exec: () => Promise.resolve({ _id: 'r1' }),
    }),
  );

  // findDeleted reads through a chained query; the mock records the filter so the
  // assertions can prove what it asked the database for.
  const findFilters: any[] = [];
  const find = jest.fn((filter: any) => {
    findFilters.push(filter);
    const chain: any = {
      sort: () => chain,
      skip: () => chain,
      limit: () => chain,
      exec: () => Promise.resolve([{ _id: 'r1' }, { _id: 'r2' }]),
    };
    return chain;
  });
  const countFilters: any[] = [];
  const countDocuments = jest.fn((filter: any) => {
    countFilters.push(filter);
    return { limit: () => ({ exec: () => Promise.resolve(2) }) };
  });

  const model: any = {
    schema: { path: (name: string) => (paths.has(name) ? {} : undefined) },
    deleteOne,
    updateOne,
    findOneAndUpdate,
    find,
    countDocuments,
  };

  const cls: any = {
    get: (key: string) => (key === 'userId' ? options.userId : undefined),
  };

  return {
    repo: new TestRepository(model, cls),
    deleteOne,
    updateOne,
    findOneAndUpdate,
    find,
    findFilters,
    countDocuments,
    countFilters,
  };
}

describe('BaseDocumentRepository.remove — soft delete', () => {
  it('should SOFT delete when the schema declares deletedAt', async () => {
    const { repo, updateOne, deleteOne } = makeRepo();

    await repo.remove('r1');

    expect(deleteOne).not.toHaveBeenCalled();
    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'r1' },
      { $set: expect.objectContaining({ deletedAt: expect.any(Date) }) },
    );
  });

  it('should stamp who deleted it when the schema tracks updatedById', async () => {
    const { repo, updateOne } = makeRepo({ userId: 'u1' });
    await repo.remove('r1');
    expect(updateOne.mock.calls[0][1].$set.updatedById).toBe('u1');
  });

  it('should not invent an updatedById the schema has no field for', async () => {
    const { repo, updateOne } = makeRepo({
      paths: ['deletedAt'],
      userId: 'u1',
    });
    await repo.remove('r1');
    expect(updateOne.mock.calls[0][1].$set.updatedById).toBeUndefined();
  });

  it('should omit the actor when there is no user in context', async () => {
    // A cron or system path. The delete must still work.
    const { repo, updateOne } = makeRepo();
    await repo.remove('r1');
    expect(updateOne.mock.calls[0][1].$set.updatedById).toBeUndefined();
    expect(updateOne.mock.calls[0][1].$set.deletedAt).toBeInstanceOf(Date);
  });
});

describe('BaseDocumentRepository.remove — hard delete', () => {
  it('should HARD delete when the schema has no deletedAt', async () => {
    // Collections that genuinely want permanent deletion keep the old behaviour, so
    // this change could not silently turn a cleanup into an accumulating table.
    const { repo, deleteOne, updateOne } = makeRepo({ paths: [] });

    await repo.remove('r1');

    expect(deleteOne).toHaveBeenCalledWith({ _id: 'r1' });
    expect(updateOne).not.toHaveBeenCalled();
  });
});

describe('BaseDocumentRepository.restore', () => {
  it('should UNSET deletedAt rather than writing null', async () => {
    // Several repositories filter `deletedAt: { $exists: false }`, which treats a
    // present-but-null field as still deleted. Restoring to null would leave the
    // record restored in the database and still invisible in the UI.
    const { repo, findOneAndUpdate } = makeRepo();

    await repo.restore('r1');

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'r1', deletedAt: { $ne: null } }),
      { $unset: { deletedAt: '' } },
      { new: true },
    );
  });

  it('should return the mapped domain object', async () => {
    const { repo } = makeRepo();
    expect(await repo.restore('r1')).toEqual({ id: 'r1', mapped: true });
  });

  it('should only match a record that is actually deleted', async () => {
    // Restoring a live record should be a no-op, not a write.
    const { repo, findOneAndUpdate } = makeRepo();
    await repo.restore('r1');
    expect(findOneAndUpdate.mock.calls[0][0].deletedAt).toEqual({ $ne: null });
  });

  it('should be a no-op for a collection with no deletedAt', async () => {
    const { repo, findOneAndUpdate } = makeRepo({ paths: [] });
    expect(await repo.restore('r1')).toBeNull();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('BaseDocumentRepository.findDeleted — the recycle bin', () => {
  it('should ask only for rows that carry a deletedAt', async () => {
    const { repo, findFilters } = makeRepo();

    await repo.findDeleted({ page: 1, limit: 25 });

    // `$ne: null` and not `$exists: true`: a restore UNSETS the field, so a restored
    // row must fall out of the bin, and a legacy row that never had the field must
    // never fall into it.
    expect(findFilters[0]).toEqual({ deletedAt: { $ne: null } });
  });

  it('should page from the requested offset', async () => {
    const { repo, find } = makeRepo();
    const chain = {
      sort: jest.fn(),
      skip: jest.fn(),
      limit: jest.fn(),
      exec: jest.fn(),
    };
    chain.sort.mockReturnValue(chain);
    chain.skip.mockReturnValue(chain);
    chain.limit.mockReturnValue(chain);
    chain.exec.mockResolvedValue([]);
    find.mockReturnValue(chain as any);

    await repo.findDeleted({ page: 3, limit: 20 });

    expect(chain.sort).toHaveBeenCalledWith({ deletedAt: -1 });
    expect(chain.skip).toHaveBeenCalledWith(40);
    expect(chain.limit).toHaveBeenCalledWith(20);
  });

  it('should map rows to the domain shape', async () => {
    const { repo } = makeRepo();
    const { data, total } = await repo.findDeleted({ page: 1, limit: 25 });
    expect(data).toEqual([
      { id: 'r1', mapped: true },
      { id: 'r2', mapped: true },
    ]);
    expect(total).toBe(2);
  });

  it('should return an EMPTY bin for a collection that hard-deletes', async () => {
    // The important one. A shared recycle-bin page pointed at a hard-deleting domain
    // must not become a list of LIVE records with a restore button: with no
    // `deletedAt` path, `{ deletedAt: { $ne: null } }` matches every document.
    const { repo, find, countDocuments } = makeRepo({ paths: [] });

    const result = await repo.findDeleted({ page: 1, limit: 25 });

    expect(result).toEqual({ data: [], total: 0 });
    expect(find).not.toHaveBeenCalled();
    expect(countDocuments).not.toHaveBeenCalled();
  });
});
