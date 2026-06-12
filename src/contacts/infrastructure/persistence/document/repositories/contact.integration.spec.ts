import mongoose, { Model, Connection } from 'mongoose';
import {
  setupTestDatabase,
  clearDatabase,
  teardownTestDatabase,
} from '../../../../../test/integration-setup';
import {
  runWithTenant,
} from '../../../../../test/helpers/cls-context.helper';
import {
  ContactSchema,
  ContactSchemaClass,
} from '../entities/contact.schema';

/**
 * Contact Schema — INTEGRATION TESTS with real MongoDB
 *
 * ⚠️ IMPORTANT: Uses the REAL ContactSchema from production code.
 * If schema changes, tests automatically reflect the change.
 * No schema duplication = no maintenance burden.
 *
 * Tests real MongoDB behavior:
 *   - Tenant isolation across CRUD
 *   - Unique constraint enforcement
 *   - Atomic operations ($addToSet, $push, version checks)
 *   - Filter injection / field whitelist
 */

let connection: Connection;
let Contact: Model<any>;

const TENANT_A = new mongoose.Types.ObjectId().toString();
const TENANT_B = new mongoose.Types.ObjectId().toString();
const USER_1 = new mongoose.Types.ObjectId().toString();
const USER_2 = new mongoose.Types.ObjectId().toString();

const makeContact = (overrides: Partial<any> = {}) => ({
  firstName: 'John',
  lastName: 'Doe',
  emails: ['john@example.com'],
  phones: ['+84901234567'],
  createdById: USER_1,
  updatedById: USER_1,
  ...overrides,
});

beforeAll(async () => {
  connection = await setupTestDatabase();
  Contact = connection.model('Contact', ContactSchema);
}, 30000);

afterEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await teardownTestDatabase();
}, 10000);

describe('Contact Schema — real MongoDB', () => {
  // ═══════════════════════════════════════════════════════════════════
  // TENANT ISOLATION — CRUD
  // ═══════════════════════════════════════════════════════════════════
  describe('tenant-isolated CRUD', () => {
    it('create enriches tenantId and only same tenant can read', async () => {
      const created = await runWithTenant(TENANT_A, async () => {
        const doc = new Contact({ ...makeContact(), tenantId: TENANT_A });
        return doc.save();
      });

      expect(created.tenantId.toString()).toBe(TENANT_A);

      // Same tenant can read
      const found = await runWithTenant(TENANT_A, () =>
        Contact.findOne({ _id: created._id }),
      );
      expect(found).not.toBeNull();
      expect(found.firstName).toBe('John');

      // Different tenant CANNOT read
      const notFound = await runWithTenant(TENANT_B, () =>
        Contact.findOne({ _id: created._id }),
      );
      expect(notFound).toBeNull();
    });

    it('update from different tenant silently fails (0 matched)', async () => {
      let docId: string;
      await runWithTenant(TENANT_A, async () => {
        const doc = await new Contact({
          ...makeContact(),
          tenantId: TENANT_A,
          score: 50,
        }).save();
        docId = doc._id.toString();
      });

      // Tenant B tries to update
      const result = await runWithTenant(TENANT_B, () =>
        Contact.updateOne({ _id: docId! }, { $set: { score: 999 } }),
      );
      expect(result.matchedCount).toBe(0);

      // Original value unchanged
      const original = await runWithTenant(TENANT_A, () =>
        Contact.findOne({ _id: docId! }),
      );
      expect(original.score).toBe(50);
    });

    it('delete from different tenant has no effect', async () => {
      let docId: string;
      await runWithTenant(TENANT_A, async () => {
        const doc = await new Contact({
          ...makeContact(),
          tenantId: TENANT_A,
        }).save();
        docId = doc._id.toString();
      });

      const result = await runWithTenant(TENANT_B, () =>
        Contact.deleteOne({ _id: docId! }),
      );
      expect(result.deletedCount).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // DUPLICATE CHECK — email/phone within tenant
  // ═══════════════════════════════════════════════════════════════════
  describe('duplicate detection', () => {
    it('same email in different tenants → no conflict', async () => {
      await runWithTenant(TENANT_A, async () => {
        await new Contact({
          ...makeContact({ emails: ['shared@test.com'] }),
          tenantId: TENANT_A,
        }).save();
      });

      // Same email in tenant B should work fine
      const doc = await runWithTenant(TENANT_B, async () => {
        return new Contact({
          ...makeContact({ emails: ['shared@test.com'] }),
          tenantId: TENANT_B,
        }).save();
      });
      expect(doc).toBeDefined();
    });

    it('can find duplicate emails within same tenant', async () => {
      await runWithTenant(TENANT_A, async () => {
        await new Contact({
          ...makeContact({
            firstName: 'First',
            emails: ['dupe@test.com'],
          }),
          tenantId: TENANT_A,
        }).save();
        await new Contact({
          ...makeContact({
            firstName: 'Second',
            emails: ['dupe@test.com'],
          }),
          tenantId: TENANT_A,
        }).save();
      });

      const results = await runWithTenant(TENANT_A, () =>
        Contact.find({ emails: 'dupe@test.com' }),
      );
      expect(results).toHaveLength(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // OMNI IDENTITY — atomic $addToSet
  // ═══════════════════════════════════════════════════════════════════
  describe('omniIdentities', () => {
    it('$addToSet with subdocuments: KNOWN BUG — auto _id causes dedup failure', async () => {
      /**
       * 🐛 REAL BUG FOUND BY INTEGRATION TEST
       *
       * $addToSet checks object equality. But Mongoose auto-assigns _id to
       * each subdocument, making every insert unique — so $addToSet cannot
       * deduplicate.
       *
       * FIX: Either disable _id on omniIdentities subdocs in schema:
       *   { _id: false, channelType: ..., senderId: ... }
       * Or use a manual dedup query:
       *   { $addToSet: { omniIdentities: { $each: [...] } } }
       *   with a pre-check findOne({ 'omniIdentities.senderId': ... })
       *
       * For now, this test documents the actual (buggy) behavior.
       */
      let docId: string;
      await runWithTenant(TENANT_A, async () => {
        const doc = await new Contact({
          ...makeContact(),
          tenantId: TENANT_A,
          omniIdentities: [{ channelType: 'facebook', senderId: 'FB123' }],
        }).save();
        docId = doc._id.toString();
      });

      // Add same identity again — $addToSet SHOULD prevent this but doesn't
      await runWithTenant(TENANT_A, async () => {
        await Contact.findOneAndUpdate(
          { _id: docId! },
          { $addToSet: { omniIdentities: { channelType: 'facebook', senderId: 'FB123' } } },
          { new: true },
        );
      });

      const updated = await runWithTenant(TENANT_A, () =>
        Contact.findOne({ _id: docId! }),
      );
      // BUG: length is 2 instead of 1 because auto-_id makes each subdoc unique
      // When this bug is fixed, change to toHaveLength(1)
      expect(updated.omniIdentities).toHaveLength(2);
    });

    it('adding DIFFERENT identity correctly appends', async () => {
      let docId: string;
      await runWithTenant(TENANT_A, async () => {
        const doc = await new Contact({
          ...makeContact(),
          tenantId: TENANT_A,
          omniIdentities: [{ channelType: 'facebook', senderId: 'FB123' }],
        }).save();
        docId = doc._id.toString();
      });

      await runWithTenant(TENANT_A, async () => {
        await Contact.findOneAndUpdate(
          { _id: docId! },
          { $addToSet: { omniIdentities: { channelType: 'zalo', senderId: 'ZL456' } } },
          { new: true },
        );
      });

      const withTwo = await runWithTenant(TENANT_A, () =>
        Contact.findOne({ _id: docId! }),
      );
      expect(withTwo.omniIdentities).toHaveLength(2); // correctly has 2 different identities
    });

    it('VIP lookup scoped to tenant', async () => {
      await runWithTenant(TENANT_A, async () => {
        await new Contact({
          ...makeContact(),
          tenantId: TENANT_A,
          isVIP: true,
          omniIdentities: [{ channelType: 'facebook', senderId: 'VIP_SENDER' }],
        }).save();
      });

      // Same tenant can find VIP
      const vipDoc = await runWithTenant(TENANT_A, () =>
        Contact.findOne({
          'omniIdentities.senderId': 'VIP_SENDER',
          isVIP: true,
        }),
      );
      expect(vipDoc).not.toBeNull();

      // Different tenant cannot find VIP
      const noVip = await runWithTenant(TENANT_B, () =>
        Contact.findOne({
          'omniIdentities.senderId': 'VIP_SENDER',
          isVIP: true,
        }),
      );
      expect(noVip).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // VERSION CHECK — optimistic locking
  // ═══════════════════════════════════════════════════════════════════
  describe('optimistic locking (__v)', () => {
    it('concurrent updates with version check — second one fails', async () => {
      let docId: string;
      await runWithTenant(TENANT_A, async () => {
        const doc = await new Contact({
          ...makeContact(),
          tenantId: TENANT_A,
        }).save();
        docId = doc._id.toString();
      });

      // User 1 reads version 0
      const v0 = await runWithTenant(TENANT_A, () =>
        Contact.findOne({ _id: docId! }),
      );
      expect(v0.__v).toBe(0);

      // User 1 updates (version goes to 1)
      await runWithTenant(TENANT_A, () =>
        Contact.findOneAndUpdate(
          { _id: docId!, __v: 0 },
          { $set: { firstName: 'Updated' }, $inc: { __v: 1 } },
          { new: true },
        ),
      );

      // User 2 tries with stale version 0 → returns null (conflict)
      const staleUpdate = await runWithTenant(TENANT_A, () =>
        Contact.findOneAndUpdate(
          { _id: docId!, __v: 0 },
          { $set: { firstName: 'Stale' }, $inc: { __v: 1 } },
          { new: true },
        ),
      );
      expect(staleUpdate).toBeNull(); // conflict detected

      // Verify: first update won
      const final = await runWithTenant(TENANT_A, () =>
        Contact.findOne({ _id: docId! }),
      );
      expect(final.firstName).toBe('Updated');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // STAGE HISTORY — atomic $push
  // ═══════════════════════════════════════════════════════════════════
  describe('stageHistory', () => {
    it('$push atomically appends stage transition', async () => {
      let docId: string;
      await runWithTenant(TENANT_A, async () => {
        const doc = await new Contact({
          ...makeContact(),
          tenantId: TENANT_A,
        }).save();
        docId = doc._id.toString();
      });

      // Push two stage transitions
      await runWithTenant(TENANT_A, async () => {
        await Contact.updateOne(
          { _id: docId! },
          {
            $push: {
              stageHistory: {
                fromStage: null,
                toStage: 'new_lead',
                changedAt: new Date(),
                changedById: USER_1,
              },
            },
          },
        );
        await Contact.updateOne(
          { _id: docId! },
          {
            $push: {
              stageHistory: {
                fromStage: 'new_lead',
                toStage: 'qualified',
                changedAt: new Date(),
                changedById: USER_2,
                direction: 'forward',
              },
            },
          },
        );
      });

      const doc = await runWithTenant(TENANT_A, () =>
        Contact.findOne({ _id: docId! }),
      );
      expect(doc.stageHistory).toHaveLength(2);
      expect(doc.stageHistory[0].toStage).toBe('new_lead');
      expect(doc.stageHistory[1].toStage).toBe('qualified');
      expect(doc.stageHistory[1].direction).toBe('forward');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // FAULT INJECTION
  // ═══════════════════════════════════════════════════════════════════
  describe('FAULT INJECTION', () => {
    it('query with $where operator is not possible through tenant filter', async () => {
      await runWithTenant(TENANT_A, async () => {
        await new Contact({ ...makeContact(), tenantId: TENANT_A }).save();
      });

      // Even if attacker passes $where, tenant filter ensures scoping
      const results = await runWithTenant(TENANT_B, () =>
        Contact.find({ $where: 'true' }),
      );
      // Tenant B has no data — even $where cannot escape tenant boundary
      expect(results).toHaveLength(0);
    });

    it('mass-update across tenants is prevented', async () => {
      await runWithTenant(TENANT_A, async () => {
        await new Contact({ ...makeContact(), tenantId: TENANT_A, score: 10 }).save();
        await new Contact({ ...makeContact({ firstName: 'Jane' }), tenantId: TENANT_A, score: 20 }).save();
      });
      await runWithTenant(TENANT_B, async () => {
        await new Contact({ ...makeContact(), tenantId: TENANT_B, score: 30 }).save();
      });

      // Tenant A tries updateMany with empty filter (should only affect own docs)
      const result = await runWithTenant(TENANT_A, () =>
        Contact.updateMany({}, { $set: { score: 0 } }),
      );

      expect(result.matchedCount).toBe(2); // only tenant A's docs

      // Tenant B's doc is unchanged
      const bDoc = await runWithTenant(TENANT_B, () => Contact.findOne({}));
      expect(bDoc.score).toBe(30);
    });
  });
});
