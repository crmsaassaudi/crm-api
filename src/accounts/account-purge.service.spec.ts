import { AccountPurgeService } from './account-purge.service';
import { RetentionPurgeRunner } from '../common/references/retention-purge.runner';
import { ACCOUNT_REFERENCES } from './merge/account-references.registry';

const TENANT = '60d0fe4f5311236168a109cc';
// Real ObjectId hex: the registry casts ids for the ObjectId-typed references, so a
// placeholder like 'acc_1' throws inside the cascade and the test would be asserting
// against the failure path instead of the success path.
const ACCOUNT_1 = '60d0fe4f5311236168a109ca';
const ACCOUNT_2 = '60d0fe4f5311236168a109cb';

function makeHarness(
  options: {
    candidates?: Array<{ id: string; tenantId: string }>;
    failCollections?: string[];
  } = {},
) {
  const fail = new Set(options.failCollections ?? []);

  const deletedFrom: string[] = [];
  const detachedFrom: Array<{ collection: string; update: any }> = [];

  const collection = jest.fn((name: string) => ({
    deleteMany: jest.fn(() => {
      if (fail.has(name)) return Promise.reject(new Error('write failed'));
      deletedFrom.push(name);
      return Promise.resolve({ deletedCount: 2 });
    }),
    updateMany: jest.fn((_filter: any, update: any) => {
      if (fail.has(name)) return Promise.reject(new Error('write failed'));
      detachedFrom.push({ collection: name, update });
      return Promise.resolve({ modifiedCount: 3 });
    }),
  }));

  const repository = {
    findPurgeable: jest
      .fn()
      .mockResolvedValue(
        options.candidates ?? [{ id: ACCOUNT_1, tenantId: TENANT }],
      ),
    hardDelete: jest.fn().mockResolvedValue(undefined),
  };

  // A REAL runner over the mocked connection, not a mocked runner: these assertions are
  // about the account registry's policies reaching the database correctly, and a stubbed
  // runner would assert only that the service called something.
  const runner = new RetentionPurgeRunner({ collection } as any);

  const service = new AccountPurgeService(
    repository as any,
    // Lock service: run the callback straight through.
    { acquire: jest.fn((_k: string, _o: any, fn: any) => fn()) } as any,
    runner,
  );

  return { service, repository, collection, deletedFrom, detachedFrom };
}

describe('AccountPurgeService', () => {
  const originalRetention = process.env.ACCOUNT_PURGE_RETENTION_DAYS;

  afterEach(() => {
    if (originalRetention === undefined) {
      delete process.env.ACCOUNT_PURGE_RETENTION_DAYS;
    } else {
      process.env.ACCOUNT_PURGE_RETENTION_DAYS = originalRetention;
    }
  });

  it('should cascade the loser references BEFORE hard-deleting the account', async () => {
    const h = makeHarness();
    await h.service.purgeExpired();

    // Reversed, rows would point at an id nothing can resolve — with the account gone
    // there is nothing left to find them by, which is the failure this prevents.
    const deleteOrder = h.repository.hardDelete.mock.invocationCallOrder[0];
    const cascadeOrder = h.collection.mock.invocationCallOrder[0];
    expect(cascadeOrder).toBeLessThan(deleteOrder);
  });

  it('should DETACH records with independent value, never delete them', async () => {
    const h = makeHarness();
    await h.service.purgeExpired();

    const detached = h.detachedFrom.map((d) => d.collection);
    // Revenue, support history and people must survive the purge of a company record.
    expect(detached).toContain('deals');
    expect(detached).toContain('tickets');
    expect(detached).toContain('contacts');
    expect(h.deletedFrom).not.toContain('deals');
    expect(h.deletedFrom).not.toContain('tickets');
    expect(h.deletedFrom).not.toContain('contacts');
  });

  it('should null the pointer rather than unset it when detaching', async () => {
    const h = makeHarness();
    await h.service.purgeExpired();

    const deals = h.detachedFrom.find((d) => d.collection === 'deals');
    expect(deals?.update).toEqual({ $set: { accountId: null } });
  });

  it('should CASCADE rows that describe nothing without the account', async () => {
    const h = makeHarness();
    await h.service.purgeExpired();

    // An affiliation has no meaning without the company end of it, and a timeline
    // entry describes nothing once its subject is gone.
    expect(h.deletedFrom).toContain('account_contact_relations');
    expect(h.deletedFrom).toContain('activity_logs');
  });

  it('should NEVER touch the audit trail', async () => {
    const h = makeHarness();
    await h.service.purgeExpired();

    // Compliance evidence outlives the record it describes.
    const touched = h.collection.mock.calls.map(([name]) => name);
    expect(touched).not.toContain('audit_logs');
  });

  it('should honour every registry policy, so a new entry cannot be forgotten', async () => {
    const h = makeHarness();
    await h.service.purgeExpired();

    const touched = new Set(h.collection.mock.calls.map(([name]) => name));
    for (const ref of ACCOUNT_REFERENCES) {
      if (ref.onPurge === 'keep') {
        expect(touched.has(ref.collection)).toBe(false);
      } else {
        expect(touched.has(ref.collection)).toBe(true);
      }
    }
  });

  it('should KEEP the account when its cascade fails', async () => {
    // Deleting the account while rows still point at it is the one outcome worse than
    // not purging: the rows become unreachable with nothing to find them by. Leaving it
    // soft-deleted means the next run retries.
    const h = makeHarness({ failCollections: ['deals'] });
    const result = await h.service.purgeExpired();

    expect(h.repository.hardDelete).not.toHaveBeenCalled();
    expect(result.purged).toBe(0);
  });

  it('should continue the pass after one account fails', async () => {
    const h = makeHarness({
      candidates: [
        { id: ACCOUNT_1, tenantId: TENANT },
        { id: ACCOUNT_2, tenantId: TENANT },
      ],
    });
    h.repository.hardDelete.mockRejectedValueOnce(new Error('boom'));

    const result = await h.service.purgeExpired();

    // One bad account must not stall the queue behind it forever.
    expect(result.purged).toBe(1);
    expect(h.repository.hardDelete).toHaveBeenCalledTimes(2);
  });

  it('should do nothing when the bin holds nothing expired', async () => {
    const h = makeHarness({ candidates: [] });
    const result = await h.service.purgeExpired();

    expect(result).toEqual({ purged: 0, cascaded: 0 });
    expect(h.collection).not.toHaveBeenCalled();
  });

  it('should default to a 30-day window and honour the override', async () => {
    delete process.env.ACCOUNT_PURGE_RETENTION_DAYS;
    const h = makeHarness();
    await h.service.purgeExpired();
    const [defaultCutoff] = h.repository.findPurgeable.mock.calls[0] as [Date];
    const defaultDays = Math.round(
      (Date.now() - defaultCutoff.getTime()) / 86_400_000,
    );
    expect(defaultDays).toBe(30);

    process.env.ACCOUNT_PURGE_RETENTION_DAYS = '7';
    const h2 = makeHarness();
    await h2.service.purgeExpired();
    const [cutoff] = h2.repository.findPurgeable.mock.calls[0] as [Date];
    expect(Math.round((Date.now() - cutoff.getTime()) / 86_400_000)).toBe(7);
  });

  it('should ignore a nonsense retention override rather than purge immediately', async () => {
    // `Number('') === 0` and `Number('soon')` is NaN. Either one, taken literally,
    // means a cutoff of "now" — every soft-deleted account destroyed on the next run.
    for (const bad of ['', 'soon', '-5', '0']) {
      process.env.ACCOUNT_PURGE_RETENTION_DAYS = bad;
      const h = makeHarness();
      await h.service.purgeExpired();
      const [cutoff] = h.repository.findPurgeable.mock.calls[0] as [Date];
      expect(Math.round((Date.now() - cutoff.getTime()) / 86_400_000)).toBe(30);
    }
  });

  it('should report what it did so a silent no-op is distinguishable from a clean run', async () => {
    const h = makeHarness();
    const result = await h.service.purgeExpired();

    expect(result.purged).toBe(1);
    expect(result.cascaded).toBeGreaterThan(0);
  });
});
