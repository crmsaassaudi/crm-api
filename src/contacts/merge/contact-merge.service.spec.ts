import { ConflictException, NotFoundException } from '@nestjs/common';
import { ContactMergeService } from './contact-merge.service';
import { Contact } from '../domain/contact';
import { MERGE_REFERENCES } from '../contact-references.registry';

const SURVIVOR = '60d0fe4f5311236168a109ca';
const LOSER = '60d0fe4f5311236168a109cb';
const TENANT = '60d0fe4f5311236168a109cc';

const contact = (id: string, overrides: Partial<Contact> = {}): Contact =>
  ({
    id,
    tenantId: TENANT,
    firstName: 'A',
    lastName: 'B',
    emails: [],
    phones: [],
    tags: [],
    omniIdentities: [],
    stageHistory: [],
    lifecycleStageId: 'lead',
    statusId: 'new',
    createdById: 'u1',
    updatedById: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 0,
    ...overrides,
  }) as Contact;

function makeHarness(
  options: {
    survivor?: Contact;
    loser?: Contact;
    matchedCount?: number;
    versionConflict?: boolean;
    pairRows?: any[];
    twin?: any;
  } = {},
) {
  const survivor = options.survivor ?? contact(SURVIVOR);
  const loser = options.loser ?? contact(LOSER);

  const updateMany = jest
    .fn()
    .mockResolvedValue({ matchedCount: options.matchedCount ?? 2 });
  const deleteMany = jest.fn().mockResolvedValue({ deletedCount: 0 });
  // Paired collections (contact_relations, account_contact_relations) go through
  // resolvePairConflicts before re-parenting, which needs find/findOne/updateOne.
  const pairRows = options.pairRows ?? [];
  const twin = options.twin ?? null;
  const updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
  // The name parameter is declared so `collection.mock.calls` is typed as
  // `[string]` — the assertions below read it to prove which collections the
  // merge touched, which is the whole point of these tests.
  const collection = jest.fn((_name: string) => ({
    updateMany,
    deleteMany,
    updateOne,
    findOne: jest.fn(() => Promise.resolve(twin)),
    countDocuments: jest.fn().mockResolvedValue(3),
    find: () => ({
      limit: () => ({ toArray: () => Promise.resolve(pairRows) }),
      toArray: () => Promise.resolve(pairRows),
    }),
  }));

  const repository = {
    findOne: jest.fn((filter: any) =>
      Promise.resolve(String(filter._id) === SURVIVOR ? survivor : loser),
    ),
    updateWithVersionCheck: jest
      .fn()
      .mockResolvedValue(options.versionConflict ? null : survivor),
    update: jest.fn().mockResolvedValue(loser),
    restore: jest.fn().mockResolvedValue(loser),
  };

  const created: any[] = [];
  const mergeModel: any = {
    create: jest.fn((doc: any) => {
      const row = { ...doc, _id: 'merge_1', save: jest.fn() };
      created.push(row);
      return Promise.resolve(row);
    }),
    findOne: jest.fn(() => ({
      lean: () => ({ exec: () => Promise.resolve(null) }),
    })),
    findById: jest.fn(),
    find: jest.fn(),
  };

  const service = new ContactMergeService(
    repository as any,
    // Lock service: run the callback straight through.
    { acquire: jest.fn((_k: string, _t: any, fn: any) => fn()) } as any,
    { emit: jest.fn() } as any,
    {
      get: jest.fn((k: string) =>
        k === 'tenantId' || k === 'activeTenantId' ? TENANT : 'u1',
      ),
    } as any,
    { emit: jest.fn() } as any,
    { collection } as any,
    mergeModel,
    { del: jest.fn() } as any,
  );

  return {
    service,
    repository,
    mergeModel,
    created,
    collection,
    updateMany,
    deleteMany,
    updateOne,
  };
}

describe('ContactMergeService — re-parenting', () => {
  it('should touch EVERY collection that references a contact', async () => {
    // This is the regression test for the defect this service replaced: the old
    // inline merge unioned four array fields and touched no related collection
    // at all, leaving notes, tickets, deals, tasks, conversations, email bodies
    // and the timeline pointing at an archived contact.
    const { service, collection } = makeHarness();
    await service.merge(SURVIVOR, LOSER);

    const touched = collection.mock.calls.map(([name]) => name);
    for (const ref of MERGE_REFERENCES) {
      expect(touched).toContain(ref.collection);
    }
  });

  it('should NOT re-parent the audit trail', async () => {
    // Rewriting audit rows onto the survivor would falsify history.
    const { service, collection } = makeHarness();
    await service.merge(SURVIVOR, LOSER);
    expect(collection.mock.calls.map(([n]) => n)).not.toContain('audit_logs');
  });

  it('should record what moved in the ledger', async () => {
    const { service, created } = makeHarness({ matchedCount: 4 });
    const result = await service.merge(SURVIVOR, LOSER);

    expect(created).toHaveLength(1);
    expect(created[0].survivorId).toBe(SURVIVOR);
    expect(created[0].mergedId).toBe(LOSER);
    expect(created[0].reparented.notes).toBe(4);
    expect(result.reparented.notes).toBe(4);
  });

  it('should snapshot the loser so an unmerge can restore it', async () => {
    const { service, created } = makeHarness({
      loser: contact(LOSER, { emails: ['gone@x.com'] }),
    });
    await service.merge(SURVIVOR, LOSER);
    expect((created[0].mergedSnapshot as any).emails).toEqual(['gone@x.com']);
  });

  it('should re-parent BEFORE soft-deleting the loser', async () => {
    // Ordering is the difference between a repairable half-merge and rows that
    // point at a contact nothing can find.
    const order: string[] = [];
    const { service, repository, updateMany } = makeHarness();
    updateMany.mockImplementation(() => {
      order.push('reparent');
      return Promise.resolve({ matchedCount: 1 });
    });
    repository.update.mockImplementation(() => {
      order.push('soft-delete');
      return Promise.resolve(contact(LOSER));
    });

    await service.merge(SURVIVOR, LOSER);
    expect(order.indexOf('reparent')).toBeLessThan(
      order.indexOf('soft-delete'),
    );
  });
});

describe('ContactMergeService — paired rows (relationships, affiliations)', () => {
  it('should re-parent BOTH endpoints of the person relationship graph', async () => {
    // Moving only `fromContactId` would leave every relationship pointing AT the
    // merged-away contact dangling.
    const { service, collection } = makeHarness();
    await service.merge(SURVIVOR, LOSER);

    const relationCalls = collection.mock.calls.filter(
      ([name]) => name === 'contact_relations',
    );
    // Two registry entries × (conflict pass + reparent pass) — at minimum both
    // endpoint entries were processed.
    expect(relationCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('should drop a row that would become a self-reference', async () => {
    // "A reports_to B" merged A→B would become "B reports_to B" — vacuous, and it
    // would also collide with nothing while corrupting the graph.
    const { service, updateMany } = makeHarness();
    await service.merge(SURVIVOR, LOSER);

    const selfRefSoftDeletes = updateMany.mock.calls.filter(
      ([, update]: any[]) => update?.$set?.deletedAt instanceof Date,
    );
    expect(selfRefSoftDeletes.length).toBeGreaterThan(0);
  });

  it('should drop the loser row when the survivor already carries the same fact', async () => {
    // A and B both report to C: re-parenting A's row collides with B's on the
    // partial unique index and would abort the whole updateMany.
    const { service, updateOne } = makeHarness({
      pairRows: [
        {
          _id: 'rel_loser',
          toContactId: 'contact_c',
          relationType: 'reports_to',
        },
      ],
      twin: { _id: 'rel_survivor' },
    });

    await service.merge(SURVIVOR, LOSER);

    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'rel_loser' },
      { $set: { deletedAt: expect.any(Date) } },
    );
  });

  it('should keep the loser row when the survivor has no equivalent', async () => {
    const { service, updateOne } = makeHarness({
      pairRows: [
        {
          _id: 'rel_loser',
          toContactId: 'contact_c',
          relationType: 'reports_to',
        },
      ],
      twin: null,
    });

    await service.merge(SURVIVOR, LOSER);

    const softDeletedLoser = updateOne.mock.calls.some(
      ([filter]: any[]) => filter?._id === 'rel_loser',
    );
    expect(softDeletedLoser).toBe(false);
  });

  it('should re-parent company affiliations', async () => {
    const { service, collection } = makeHarness();
    await service.merge(SURVIVOR, LOSER);
    expect(collection.mock.calls.map(([n]) => n)).toContain(
      'account_contact_relations',
    );
  });
});

describe('ContactMergeService — guards', () => {
  it('should refuse to merge a contact into itself', async () => {
    const { service } = makeHarness();
    await expect(service.merge(SURVIVOR, SURVIVOR)).rejects.toThrow(
      'Cannot merge a contact into itself',
    );
  });

  it('should reject a merge whose target is already deleted', async () => {
    const { service } = makeHarness({
      loser: contact(LOSER, { deletedAt: new Date() }),
    });
    await expect(service.merge(SURVIVOR, LOSER)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('should fail on a concurrent edit to the survivor', async () => {
    // The lock serialises merges of this pair but not an ordinary PATCH by an
    // agent who had the contact open; without the version check that edit is
    // silently overwritten by our pre-merge snapshot.
    const { service } = makeHarness({ versionConflict: true });
    await expect(service.merge(SURVIVOR, LOSER)).rejects.toThrow(
      ConflictException,
    );
  });

  it('should soft-delete, never hard-delete, the merged-away contact', async () => {
    const { service, repository } = makeHarness();
    await service.merge(SURVIVOR, LOSER);
    expect(repository.update).toHaveBeenCalledWith(
      LOSER,
      expect.objectContaining({ deletedAt: expect.any(Date) }),
    );
  });
});

describe('ContactMergeService — preview', () => {
  it('should report field outcomes and counts without writing', async () => {
    const { service, repository, updateMany, created } = makeHarness({
      survivor: contact(SURVIVOR, { emails: ['a@x.com'] }),
      loser: contact(LOSER, { emails: ['b@x.com'], title: 'CTO' }),
    });

    const preview = await service.preview(SURVIVOR, LOSER);

    expect(preview.fieldChoices.emails.chosen).toEqual(['a@x.com', 'b@x.com']);
    expect(preview.fieldChoices.title).toEqual({
      chosen: 'CTO',
      from: 'merged',
    });
    expect(preview.willReparent.notes).toBe(3);

    // Nothing written.
    expect(updateMany).not.toHaveBeenCalled();
    expect(repository.updateWithVersionCheck).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });
});

describe('ContactMergeService — unmerge', () => {
  const ledger = (overrides: any = {}) => ({
    _id: 'merge_1',
    survivorId: SURVIVOR,
    mergedId: LOSER,
    reparented: { notes: 2 },
    revertedAt: null,
    save: jest.fn(),
    ...overrides,
  });

  it('should restore the loser and move its rows back', async () => {
    const harness = makeHarness();
    const row = ledger();
    harness.mergeModel.findById = jest.fn(() => ({
      exec: () => Promise.resolve(row),
    }));

    const result = await harness.service.unmerge('merge_1');

    expect(harness.repository.restore).toHaveBeenCalledWith(LOSER);
    expect(result.restoredId).toBe(LOSER);
    expect(row.revertedAt).toBeInstanceOf(Date);
    expect(row.save).toHaveBeenCalled();
  });

  it('should only move back the collections this merge actually moved', async () => {
    const harness = makeHarness();
    harness.mergeModel.findById = jest.fn(() => ({
      exec: () => Promise.resolve(ledger({ reparented: { notes: 2 } })),
    }));

    await harness.service.unmerge('merge_1');

    const touched = harness.collection.mock.calls.map(([n]) => n);
    expect(touched).toEqual(['notes']);
  });

  it('should refuse to revert twice', async () => {
    const harness = makeHarness();
    harness.mergeModel.findById = jest.fn(() => ({
      exec: () => Promise.resolve(ledger({ revertedAt: new Date() })),
    }));
    await expect(harness.service.unmerge('merge_1')).rejects.toThrow(
      'already been reverted',
    );
  });

  it('should report clearly when the loser has already been purged', async () => {
    const harness = makeHarness();
    harness.mergeModel.findById = jest.fn(() => ({
      exec: () => Promise.resolve(ledger()),
    }));
    harness.repository.restore.mockResolvedValue(null);

    await expect(harness.service.unmerge('merge_1')).rejects.toThrow('purged');
  });
});
