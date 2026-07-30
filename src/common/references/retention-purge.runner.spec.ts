import {
  RetentionPurgeRunner,
  resolveRetentionDays,
} from './retention-purge.runner';
import { EntityReference } from './entity-reference';

const TENANT = '60d0fe4f5311236168a109cc';
const RECORD = '60d0fe4f5311236168a109ca';
const OTHER = '60d0fe4f5311236168a109cb';

const REFERENCES: readonly EntityReference[] = [
  {
    collection: 'children',
    field: 'parentId',
    kind: 'objectId',
    label: 'children',
    onMerge: 'reparent',
    onPurge: 'detach',
  },
  {
    collection: 'timeline',
    field: 'targetId',
    kind: 'discriminatedString',
    discriminator: { field: 'targetType', value: 'thing' },
    label: 'timeline entries',
    onMerge: 'reparent',
    onPurge: 'cascade',
  },
  {
    collection: 'baskets',
    field: 'thingIds',
    kind: 'objectIdArray',
    label: 'baskets',
    onMerge: 'reparent',
    onPurge: 'pull',
  },
  {
    collection: 'tasks',
    field: 'relatedTo',
    kind: 'relatedTo',
    discriminator: { field: 'type', value: 'Thing' },
    label: 'tasks',
    onMerge: 'reparent',
    onPurge: 'detach',
  },
  {
    collection: 'audit_logs',
    field: 'entityId',
    kind: 'discriminatedString',
    discriminator: { field: 'entityType', value: 'THING' },
    label: 'audit entries',
    onMerge: 'keep',
    onPurge: 'keep',
  },
];

function makeHarness(
  options: {
    candidates?: Array<{ id: string; tenantId: string }>;
    failCollections?: string[];
  } = {},
) {
  const fail = new Set(options.failCollections ?? []);
  const calls: Array<{ collection: string; op: string; args: any[] }> = [];

  const collection = jest.fn((name: string) => {
    const record =
      (op: string) =>
      (...args: any[]) => {
        if (fail.has(name)) return Promise.reject(new Error('write failed'));
        calls.push({ collection: name, op, args });
        return Promise.resolve({ deletedCount: 1, modifiedCount: 1 });
      };
    return {
      deleteMany: jest.fn(record('deleteMany')),
      updateMany: jest.fn(record('updateMany')),
    };
  });

  const repository = {
    findPurgeable: jest
      .fn()
      .mockResolvedValue(
        options.candidates ?? [{ id: RECORD, tenantId: TENANT }],
      ),
    hardDelete: jest.fn().mockResolvedValue(undefined),
  };

  const runner = new RetentionPurgeRunner({ collection } as any);

  const run = () =>
    runner.run({
      entity: 'thing',
      references: REFERENCES,
      repository,
      retentionDays: 30,
    });

  return { runner, run, repository, collection, calls };
}

describe('RetentionPurgeRunner', () => {
  it('should cascade references BEFORE hard-deleting the record', async () => {
    const h = makeHarness();
    await h.run();

    // Reversed, the rows point at an id nothing resolves and there is nothing left to
    // find them by. This ordering is the whole reason the runner exists rather than each
    // domain doing it again.
    expect(h.collection.mock.invocationCallOrder[0]).toBeLessThan(
      h.repository.hardDelete.mock.invocationCallOrder[0],
    );
  });

  it('should DELETE cascade references', async () => {
    const h = makeHarness();
    await h.run();
    const timeline = h.calls.find((c) => c.collection === 'timeline');
    expect(timeline?.op).toBe('deleteMany');
  });

  it('should NULL a detached ObjectId pointer', async () => {
    const h = makeHarness();
    await h.run();
    const children = h.calls.find((c) => c.collection === 'children');
    expect(children?.op).toBe('updateMany');
    expect(children?.args[1]).toEqual({ $set: { parentId: null } });
  });

  it('should UNSET a detached relatedTo sub-document', async () => {
    // Nulling `relatedTo` would leave a sub-document with a dangling `_id` and a stale
    // `name` — which is how a purged record keeps appearing in task lists.
    const h = makeHarness();
    await h.run();
    const tasks = h.calls.find((c) => c.collection === 'tasks');
    expect(tasks?.args[1]).toEqual({ $unset: { relatedTo: '' } });
  });

  it('should PULL from an array and then delete rows left referencing nobody', async () => {
    const h = makeHarness();
    await h.run();
    const basketOps = h.calls.filter((c) => c.collection === 'baskets');
    expect(basketOps.map((c) => c.op)).toEqual(['updateMany', 'deleteMany']);
    expect(basketOps[1].args[0]).toEqual(
      expect.objectContaining({ thingIds: { $size: 0 } }),
    );
  });

  it('should never touch a keep reference', async () => {
    const h = makeHarness();
    await h.run();
    expect(h.calls.map((c) => c.collection)).not.toContain('audit_logs');
  });

  it('should scope every cascade to the tenant', async () => {
    // These run on the raw connection, which has no tenant plugin. A missing tenant
    // predicate here makes a purge cross-tenant — the worst possible bug in this file.
    const h = makeHarness();
    await h.run();
    for (const call of h.calls) {
      expect(call.args[0]).toHaveProperty('tenantId');
    }
  });

  it('should KEEP the record when its cascade fails', async () => {
    const h = makeHarness({ failCollections: ['children'] });
    const result = await h.run();

    // Deleting it while rows still reference it is the one outcome worse than not
    // purging at all.
    expect(h.repository.hardDelete).not.toHaveBeenCalled();
    expect(result.purged).toBe(0);
  });

  it('should continue past one failing record', async () => {
    const h = makeHarness({
      candidates: [
        { id: RECORD, tenantId: TENANT },
        { id: OTHER, tenantId: TENANT },
      ],
    });
    h.repository.hardDelete.mockRejectedValueOnce(new Error('boom'));

    const result = await h.run();

    expect(result.purged).toBe(1);
    expect(h.repository.hardDelete).toHaveBeenCalledTimes(2);
  });

  it('should do nothing when nothing is expired', async () => {
    const h = makeHarness({ candidates: [] });
    expect(await h.run()).toEqual({ purged: 0, cascaded: 0 });
    expect(h.collection).not.toHaveBeenCalled();
  });

  it('should ask for the cutoff derived from the retention window', async () => {
    const h = makeHarness();
    await h.run();
    const [cutoff] = h.repository.findPurgeable.mock.calls[0] as [Date];
    expect(Math.round((Date.now() - cutoff.getTime()) / 86_400_000)).toBe(30);
  });
});

describe('resolveRetentionDays', () => {
  const VAR = 'TEST_RETENTION_DAYS';
  afterEach(() => delete process.env[VAR]);

  it('should use the configured value', () => {
    process.env[VAR] = '7';
    expect(resolveRetentionDays(VAR, 30)).toBe(7);
  });

  it.each(['', 'soon', '0', '-5', 'NaN'])(
    'should fall back rather than treat %p as a retention window',
    (bad) => {
      // `Number('')` is 0 and `Number('soon')` is NaN. Either taken literally means a
      // cutoff of "now" — every soft-deleted record destroyed on the next run. The
      // fallback is the difference between a misconfigured deploy and data loss.
      process.env[VAR] = bad;
      expect(resolveRetentionDays(VAR, 30)).toBe(30);
    },
  );

  it('should fall back when unset', () => {
    expect(resolveRetentionDays(VAR, 30)).toBe(30);
  });
});
