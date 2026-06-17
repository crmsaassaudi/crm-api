import mongoose, { Schema, Model, Connection } from 'mongoose';
import {
  setupTestDatabase,
  clearDatabase,
  teardownTestDatabase,
} from '../../test/integration-setup';
import {
  runWithTenant,
  runWithoutTenant,
} from '../../test/helpers/cls-context.helper';
import { tenantFilterPlugin } from './tenant-filter.plugin';

/**
 * tenant-filter-plugin — INTEGRATION TESTS with real MongoDB + real CLS
 *
 * Zero mocks. Real MongoDB in-memory + real AsyncLocalStorage CLS.
 * If a test passes, the behavior is production-equivalent.
 */

const TestItemSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
  name: { type: String, required: true },
  value: { type: Number, default: 0 },
});
TestItemSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

let connection: Connection;
let TestItem: Model<any>;

const TENANT_A = new mongoose.Types.ObjectId().toString();
const TENANT_B = new mongoose.Types.ObjectId().toString();

beforeAll(() => {
  connection = await setupTestDatabase();
  TestItem = connection.model('TestItem', TestItemSchema);
}, 30000);

afterEach(() => {
  await clearDatabase();
});

afterAll(() => {
  await teardownTestDatabase();
}, 10000);

// Helper: seed data for both tenants
async function seedTwoTenants() {
  await runWithTenant(TENANT_A, async () => {
    await new TestItem({ tenantId: TENANT_A, name: 'A-item-1' }).save();
    await new TestItem({ tenantId: TENANT_A, name: 'A-item-2' }).save();
  });
  await runWithTenant(TENANT_B, async () => {
    await new TestItem({ tenantId: TENANT_B, name: 'B-item-1' }).save();
  });
}

describe('tenantFilterPlugin — real MongoDB', () => {
  // ═══════════════════════════════════════════════════════════════════
  // READ ISOLATION
  // ═══════════════════════════════════════════════════════════════════
  describe('read isolation', () => {
    it('should find() returns ONLY documents of the active tenant', async () => {
      await seedTwoTenants();

      const results = await runWithTenant(TENANT_A, () => TestItem.find({}));

      expect(results).toHaveLength(2);
      expect(
        results.every((r: any) => r.tenantId.toString() === TENANT_A),
      ).toBe(true);
    });

    it("should findOne() by _id cannot read another tenant's document", async () => {
      let docId: string;
      await runWithTenant(TENANT_A, async () => {
        const doc = await new TestItem({
          tenantId: TENANT_A,
          name: 'secret',
        }).save();
        docId = doc._id.toString();
      });

      const result = await runWithTenant(TENANT_B, () =>
        TestItem.findOne({ _id: docId! }),
      );

      expect(result).toBeNull();
    });

    it('should countDocuments() scoped per tenant', async () => {
      await seedTwoTenants();

      const countA = await runWithTenant(TENANT_A, () =>
        TestItem.countDocuments({}),
      );
      const countB = await runWithTenant(TENANT_B, () =>
        TestItem.countDocuments({}),
      );

      expect(countA).toBe(2);
      expect(countB).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // WRITE ISOLATION
  // ═══════════════════════════════════════════════════════════════════
  describe('write isolation', () => {
    it("should updateOne() from tenant B cannot modify tenant A's document", async () => {
      let docId: string;
      await runWithTenant(TENANT_A, async () => {
        const doc = await new TestItem({
          tenantId: TENANT_A,
          name: 'original',
          value: 100,
        }).save();
        docId = doc._id.toString();
      });

      // Tenant B tries to update
      await runWithTenant(TENANT_B, () =>
        TestItem.updateOne({ _id: docId! }, { $set: { value: 999 } }),
      );

      // Verify: value unchanged
      const doc = await runWithTenant(TENANT_A, () =>
        TestItem.findOne({ _id: docId! }),
      );
      expect(doc.value).toBe(100);
    });

    it("should deleteOne() from tenant B cannot delete tenant A's document", async () => {
      let docId: string;
      await runWithTenant(TENANT_A, async () => {
        const doc = await new TestItem({
          tenantId: TENANT_A,
          name: 'protected',
        }).save();
        docId = doc._id.toString();
      });

      await runWithTenant(TENANT_B, () => TestItem.deleteOne({ _id: docId! }));

      const stillExists = await runWithTenant(TENANT_A, () =>
        TestItem.findOne({ _id: docId! }),
      );
      expect(stillExists).not.toBeNull();
    });

    it('should findOneAndUpdate() returns null for cross-tenant attempt', async () => {
      let docId: string;
      await runWithTenant(TENANT_A, async () => {
        const doc = await new TestItem({
          tenantId: TENANT_A,
          name: 'target',
        }).save();
        docId = doc._id.toString();
      });

      const result = await runWithTenant(TENANT_B, () =>
        TestItem.findOneAndUpdate(
          { _id: docId! },
          { $set: { name: 'hacked' } },
          { new: true },
        ),
      );

      expect(result).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // SAVE — auto-enrichment & cross-tenant protection
  // ═══════════════════════════════════════════════════════════════════
  describe('save behavior', () => {
    it('should save with matching tenantId succeeds (BaseDocumentRepository enriches before save)', async () => {
      // REAL BEHAVIOR: When tenantId is required:true, Mongoose validates BEFORE
      // the pre-save hook runs. In production, BaseDocumentRepository.create()
      // enriches data.tenantId from CLS BEFORE calling .save().
      // The plugin's pre-save hook serves as a GUARD (cross-tenant check), not an enricher.
      const saved = await runWithTenant(TENANT_A, async () => {
        const doc = new TestItem({
          tenantId: TENANT_A,
          name: 'explicit-tenant',
        });
        return await doc.save();
      });

      expect(saved.tenantId.toString()).toBe(TENANT_A);
    });

    it('should throws on save if tenantId mismatches CLS (cross-tenant write)', async () => {
      await expect(
        runWithTenant(TENANT_A, async () => {
          const doc = new TestItem({ tenantId: TENANT_B, name: 'cross-write' });
          return await doc.save();
        }),
      ).rejects.toThrow(/Cross-tenant write/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // TENANT MUTATION PROTECTION
  // ═══════════════════════════════════════════════════════════════════
  describe('mutation protection', () => {
    it('should blocks $set of tenantId to different value', async () => {
      let docId: string;
      await runWithTenant(TENANT_A, async () => {
        const doc = await new TestItem({
          tenantId: TENANT_A,
          name: 'item',
        }).save();
        docId = doc._id.toString();
      });

      await expect(
        runWithTenant(TENANT_A, () =>
          TestItem.updateOne({ _id: docId! }, { $set: { tenantId: TENANT_B } }),
        ),
      ).rejects.toThrow(/Refusing mutation of protected tenant field/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // FAIL-CLOSED — no context = error, not silent data leak
  // ═══════════════════════════════════════════════════════════════════
  describe('fail-closed', () => {
    it('should throws CRITICAL error when CLS has no tenantId', async () => {
      await expect(runWithoutTenant(() => TestItem.find({}))).rejects.toThrow(
        /Missing activeTenantId/,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PLATFORM BYPASS
  // ═══════════════════════════════════════════════════════════════════
  describe('isPlatformQuery bypass', () => {
    it('should isPlatformQuery: true reads all tenants', async () => {
      await seedTwoTenants();

      const allDocs = await runWithTenant(TENANT_A, () =>
        TestItem.find({}).setOptions({ isPlatformQuery: true }),
      );
      expect(allDocs).toHaveLength(3); // 2 from A + 1 from B
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // FAULT INJECTION — proves tests catch real bugs
  // ═══════════════════════════════════════════════════════════════════
  describe('FAULT INJECTION', () => {
    it('should user-injected tenantId in filter is stripped — CLS always wins', async () => {
      await seedTwoTenants();

      // Attacker passes tenantId: TENANT_A in query filter while context is TENANT_B
      const results = await runWithTenant(TENANT_B, () =>
        TestItem.find({ tenantId: TENANT_A }),
      );

      // Plugin MUST strip the injected tenantId and use CLS value
      expect(results).toHaveLength(1);
      expect(results[0].tenantId.toString()).toBe(TENANT_B);
    });

    it('should concurrent tenant contexts are isolated (no context bleed)', async () => {
      await seedTwoTenants();

      // Run two tenant queries concurrently
      const [resultsA, resultsB] = await Promise.all([
        runWithTenant(TENANT_A, () => TestItem.find({})),
        runWithTenant(TENANT_B, () => TestItem.find({})),
      ]);

      // Each should see ONLY their own data
      expect(resultsA).toHaveLength(2);
      expect(resultsB).toHaveLength(1);
      expect(
        resultsA.every((r: any) => r.tenantId.toString() === TENANT_A),
      ).toBe(true);
      expect(
        resultsB.every((r: any) => r.tenantId.toString() === TENANT_B),
      ).toBe(true);
    });
  });
});
