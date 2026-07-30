import mongoose, { Schema, Model, Connection } from 'mongoose';
import {
  setupTestDatabase,
  clearDatabase,
  teardownTestDatabase,
} from './integration-setup';
import { runWithoutTenant } from './helpers/cls-context.helper';
import { tenantFilterPlugin } from '../common/plugins/tenant-filter.plugin';

/**
 * Queries a cron makes must declare `isPlatformQuery`.
 *
 * `tenantFilterPlugin` THROWS when CLS carries no tenant — deliberately, so a lost
 * request context can never become a cross-tenant read. A cron has no request context by
 * definition, so every query it issues must opt in explicitly.
 *
 * Three nightly jobs did not, and every one of them failed on its first query:
 *
 *   - `ContactPurgeService` — the retention purge. Its own error handler logged
 *     `Contact purge skipped: …` at DEBUG level, so a job that had never once run looked
 *     like a job that was politely standing aside for another replica. Soft-deleted
 *     contacts were never purged and GDPR erasure never completed.
 *   - `ContactRepository.recomputeScoresForAllTenants` — the nightly rescore. Its
 *     comment said "runs WITHOUT the tenant filter by design"; the design was never
 *     communicated to the plugin.
 *   - `ContactIdentityDriftService.sample` — the check that exists to notice the
 *     identity projection drifting. It could not notice anything.
 *
 * Every one was unit-tested with a mocked model, which is exactly why none of it
 * surfaced: a mock has no plugin. These tests use a real schema with the real plugin and
 * NO tenant context — the condition a cron actually runs in.
 */

const CronEntitySchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);
CronEntitySchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

let connection: Connection;
let CronModel: Model<any>;

const TENANT_A = new mongoose.Types.ObjectId().toString();
const TENANT_B = new mongoose.Types.ObjectId().toString();

beforeAll(async () => {
  connection = await setupTestDatabase();
  CronModel = connection.model('CronEntity', CronEntitySchema) as any;
}, 30000);

afterEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await teardownTestDatabase();
}, 10000);

/** Two tenants' worth of expired rows, inserted past the plugin. */
async function seedExpired(): Promise<void> {
  const old = new Date(Date.now() - 90 * 86_400_000);
  await CronModel.collection.insertMany([
    {
      tenantId: new mongoose.Types.ObjectId(TENANT_A),
      name: 'A-expired',
      deletedAt: old,
    },
    {
      tenantId: new mongoose.Types.ObjectId(TENANT_B),
      name: 'B-expired',
      deletedAt: old,
    },
    {
      tenantId: new mongoose.Types.ObjectId(TENANT_A),
      name: 'A-live',
      deletedAt: null,
    },
  ]);
}

describe('cron-time queries under the tenant plugin', () => {
  it('should THROW without a tenant when the query does not declare itself', async () => {
    // The baseline that makes the rest of this file meaningful. If the plugin ever
    // stops throwing here, the three fixes below become untested decoration and the
    // fail-closed guarantee is gone.
    await seedExpired();

    await expect(
      runWithoutTenant(() =>
        CronModel.find({ deletedAt: { $ne: null } }).exec(),
      ),
    ).rejects.toThrow(/Missing activeTenantId/);
  });

  it('should read across tenants when the query declares isPlatformQuery', async () => {
    await seedExpired();

    const rows = await runWithoutTenant(() =>
      CronModel.find({ deletedAt: { $ne: null } })
        .setOptions({ isPlatformQuery: true } as any)
        .sort({ deletedAt: 1 })
        .lean()
        .exec(),
    );

    // Retention applies to every tenant, so a purge that only saw one would leave the
    // rest accumulating forever.
    expect(rows.map((r: any) => r.name).sort()).toEqual([
      'A-expired',
      'B-expired',
    ]);
  });

  it('should still exclude rows the filter excludes', async () => {
    // `isPlatformQuery` removes the TENANT predicate, not the caller's own filter. A
    // purge that swept up live records would be catastrophic rather than merely broken.
    await seedExpired();

    const rows = await runWithoutTenant(() =>
      CronModel.find({ deletedAt: { $ne: null } })
        .setOptions({ isPlatformQuery: true } as any)
        .lean()
        .exec(),
    );

    expect(rows.map((r: any) => r.name)).not.toContain('A-live');
  });

  it('should THROW on an undeclared deleteOne, the second half of a purge', async () => {
    // `deleteOne` is one of the hooked operations. Finding the candidates is half the
    // job; the hard delete has to survive the same conditions.
    await seedExpired();
    const doomed: any = await CronModel.collection.findOne({
      name: 'A-expired',
    });

    await expect(
      runWithoutTenant(() => CronModel.deleteOne({ _id: doomed._id }).exec()),
    ).rejects.toThrow(/Missing activeTenantId/);
  });

  it('should delete without a tenant when the delete declares itself', async () => {
    await seedExpired();
    const doomed: any = await CronModel.collection.findOne({
      name: 'A-expired',
    });

    await runWithoutTenant(() =>
      CronModel.deleteOne({ _id: doomed._id })
        .setOptions({ isPlatformQuery: true } as any)
        .exec(),
    );

    expect(await CronModel.collection.findOne({ _id: doomed._id })).toBeNull();
    // The other tenant's row is untouched: the platform flag widens the read, it does
    // not widen the write beyond the `_id` the caller named.
    expect(
      await CronModel.collection.findOne({ name: 'B-expired' }),
    ).toBeTruthy();
  });
});
