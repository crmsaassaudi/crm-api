import { ContactPurgeService } from './contact-purge.service';
import { RetentionPurgeRunner } from '../common/references/retention-purge.runner';
import { CONTACT_REFERENCES } from './contact-references.registry';

const TENANT = '60d0fe4f5311236168a109cc';
// Valid ObjectId hex, not a placeholder: the registry casts ids for ObjectId-kind
// references, and `new Types.ObjectId('c1')` throws inside the cascade — where the
// per-reference catch swallows it, leaving a test that asserts against the failure path
// and reports success. That has happened twice in this codebase already.
const CONTACT_1 = '60d0fe4f5311236168a109ca';

/**
 * Contacts are the only domain whose registry uses `pull`, and the only one where a purge
 * has to decide between four different policies in one pass. The runner's own spec proves
 * each policy executes correctly against a synthetic registry; this proves the CONTACT
 * registry's real policies reach the database — notes deleted, deals pulled, tickets
 * detached, audit untouched.
 */
function makeHarness() {
  const calls: Array<{ collection: string; op: string; args: any[] }> = [];

  const collection = jest.fn((name: string) => {
    const record =
      (op: string) =>
      (...args: any[]) => {
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
      .mockResolvedValue([{ id: CONTACT_1, tenantId: TENANT }]),
    hardDelete: jest.fn().mockResolvedValue(undefined),
  };

  // The real runner over a mocked connection — a stubbed runner would only prove the
  // service called something.
  const runner = new RetentionPurgeRunner({ collection } as any);

  const service = new ContactPurgeService(
    repository as any,
    { acquire: jest.fn((_k: string, _o: any, fn: any) => fn()) } as any,
    runner,
  );

  return { service, repository, collection, calls };
}

const opsFor = (
  calls: Array<{ collection: string; op: string }>,
  collection: string,
) => calls.filter((c) => c.collection === collection).map((c) => c.op);

describe('ContactPurgeService', () => {
  it('should cascade references BEFORE hard-deleting the contact', async () => {
    const h = makeHarness();
    await h.service.purgeExpired();

    expect(h.collection.mock.invocationCallOrder[0]).toBeLessThan(
      h.repository.hardDelete.mock.invocationCallOrder[0],
    );
  });

  it('should DELETE notes — they describe nothing without the contact', async () => {
    const h = makeHarness();
    await h.service.purgeExpired();
    expect(opsFor(h.calls, 'notes')).toContain('deleteMany');
  });

  it('should PULL the contact from deals rather than delete them', async () => {
    // Revenue must never disappear because a person was erased. A deal references
    // several contacts, so the row survives with one fewer.
    const h = makeHarness();
    await h.service.purgeExpired();

    const ops = opsFor(h.calls, 'deals');
    // updateMany pulls, then deleteMany removes only rows left referencing nobody.
    expect(ops).toEqual(['updateMany', 'deleteMany']);

    const pull = h.calls.find(
      (c) => c.collection === 'deals' && c.op === 'updateMany',
    );
    expect(pull?.args[1]).toHaveProperty('$pull');

    const sweep = h.calls.find(
      (c) => c.collection === 'deals' && c.op === 'deleteMany',
    );
    expect(sweep?.args[0]).toEqual(
      expect.objectContaining({ contactIds: { $size: 0 } }),
    );
  });

  it('should DETACH tickets, keeping their SLA history', async () => {
    const h = makeHarness();
    await h.service.purgeExpired();
    expect(opsFor(h.calls, 'tickets')).toEqual(['updateMany']);
  });

  it('should UNSET the task relatedTo sub-document, not null it', async () => {
    // A `relatedTo` with a dangling `_id` and a stale `name` is how a purged contact
    // keeps appearing in task lists.
    const h = makeHarness();
    await h.service.purgeExpired();
    const task = h.calls.find((c) => c.collection === 'tasks');
    expect(task?.args[1]).toEqual({ $unset: { relatedTo: '' } });
  });

  it('should NEVER touch the audit trail', async () => {
    const h = makeHarness();
    await h.service.purgeExpired();
    expect(h.calls.map((c) => c.collection)).not.toContain('audit_logs');
  });

  it('should act on every non-keep reference in the registry', async () => {
    // So a new entry cannot be silently unhandled — the registry is the contract.
    const h = makeHarness();
    await h.service.purgeExpired();

    const touched = new Set(h.calls.map((c) => c.collection));
    for (const ref of CONTACT_REFERENCES) {
      if (ref.onPurge === 'keep') {
        expect(touched.has(ref.collection)).toBe(false);
      } else {
        expect(touched.has(ref.collection)).toBe(true);
      }
    }
  });

  it('should scope every cascade to the tenant', async () => {
    // The raw connection has no tenant plugin; a missing predicate makes a purge
    // cross-tenant.
    const h = makeHarness();
    await h.service.purgeExpired();
    for (const call of h.calls) {
      expect(call.args[0]).toHaveProperty('tenantId');
    }
  });

  it('should not throw out of the cron', async () => {
    // A cron that throws takes the scheduler's error path on every tick.
    const h = makeHarness();
    await expect(h.service.runRetentionPurge()).resolves.toBeUndefined();
  });
});
