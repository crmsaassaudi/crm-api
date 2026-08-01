import { ConflictException, NotFoundException } from '@nestjs/common';
import { BaseDocumentRepository } from './document-repository.abstract';

/**
 * A write the caller is not allowed to perform must be REFUSED, not absorbed.
 *
 * `applyTenantFilter` folds three predicates into every query — tenant,
 * data-visibility (`visibleOwnerIds`/`visibleOrgUnitIds`) and the compiled ABAC
 * deny. When any of them excludes the row, the write matches zero documents.
 * `update()` answered `null` and `remove()` answered nothing at all, so an
 * authorization denial reached the client as `200` with an empty body, or
 * `204 No Content` for a record still sitting in the database — the API
 * reporting a change it had just refused to make.
 */

type Doc = { _id: string; ownerId: string; name: string };

class TestRepository extends BaseDocumentRepository<any, Doc> {
  protected mapToDomain(doc: any): Doc {
    return doc as Doc;
  }
  protected toPersistence(domain: Doc): any {
    return { ...domain };
  }
}

describe('BaseDocumentRepository — scope denial is a refusal', () => {
  const id = '507f1f77bcf86cd799439011';

  let model: any;
  let cls: any;
  let repository: TestRepository;

  /** Nothing matches the scoped filter — the shape of a denied write. */
  const outOfScope = () => {
    model.findOneAndUpdate.mockResolvedValue(null);
    model.exists.mockResolvedValue(null);
    model.updateOne.mockResolvedValue({ matchedCount: 0 });
    model.deleteOne.mockResolvedValue({ deletedCount: 0 });
  };

  beforeEach(() => {
    model = {
      findOneAndUpdate: jest
        .fn()
        .mockResolvedValue({ _id: id, ownerId: 'u1', name: 'after' }),
      exists: jest.fn().mockResolvedValue(null),
      updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
      deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
      // No `deletedAt` path → hard delete. Overridden per test for soft delete.
      schema: { path: jest.fn().mockReturnValue(undefined) },
    };
    cls = { get: jest.fn().mockReturnValue(undefined) };
    repository = new TestRepository(model, cls);
  });

  describe('update', () => {
    it('should throw NotFound when the scoped filter matches nothing', async () => {
      outOfScope();
      await expect(repository.update(id, { name: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('should return the record when the write is allowed', async () => {
      await expect(repository.update(id, { name: 'x' })).resolves.toEqual({
        _id: id,
        ownerId: 'u1',
        name: 'after',
      });
    });

    it('should keep 409 for an optimistic-lock clash rather than downgrade it to 404', async () => {
      outOfScope();
      model.exists.mockResolvedValue({ _id: id });

      await expect(
        repository.update(id, { name: 'x', __v: 3 } as any),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('should scope the existence probe so an invisible row answers 404, not 409', async () => {
      // 409 "someone else changed it" confirms the row exists. To a caller whose
      // data-visibility excludes it, that is a disclosure — so the probe has to
      // run through the same filter as the write, minus the version predicate.
      outOfScope();
      await expect(
        repository.update(id, { name: 'x', __v: 3 } as any),
      ).rejects.toBeInstanceOf(NotFoundException);

      const probeFilter = model.exists.mock.calls[0][0];
      expect(probeFilter).toHaveProperty('_id', id);
      expect(probeFilter).not.toHaveProperty('__v');
    });

    it('should let updateIfExists absorb the miss, for idempotent sweeps only', async () => {
      outOfScope();
      await expect(repository.updateIfExists(id, { name: 'x' })).resolves.toBe(
        null,
      );
    });
  });

  describe('remove', () => {
    it('should throw NotFound rather than report a hard delete that removed nothing', async () => {
      outOfScope();
      await expect(repository.remove(id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('should throw NotFound rather than report a soft delete that matched nothing', async () => {
      outOfScope();
      model.schema.path.mockReturnValue({}); // schema has deletedAt → soft delete

      await expect(repository.remove(id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(model.updateOne).toHaveBeenCalled();
      expect(model.deleteOne).not.toHaveBeenCalled();
    });

    it('should succeed when the row is in scope', async () => {
      await expect(repository.remove(id)).resolves.toBeUndefined();
    });

    it('should let removeIfExists report the miss instead of throwing', async () => {
      outOfScope();
      await expect(repository.removeIfExists(id)).resolves.toBe(false);
    });
  });

  describe('every axis of applyTenantFilter', () => {
    it.each([
      ['data-visibility', { visibleOwnerIds: ['someone-else'] }],
      [
        'an ABAC deny',
        {
          abacResourceFilter: { resource: 'contacts', filter: { stage: 'x' } },
        },
      ],
    ])('should refuse a write excluded by %s', async (_axis, clsValues) => {
      cls.get.mockImplementation(
        (key: string) => (clsValues as Record<string, unknown>)[key],
      );
      outOfScope();

      await expect(repository.update(id, { name: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(repository.remove(id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
