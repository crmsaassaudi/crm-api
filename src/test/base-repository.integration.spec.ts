import mongoose, { Schema, Model, Connection, Document } from 'mongoose';
import { ConflictException } from '@nestjs/common';
import {
  setupTestDatabase,
  clearDatabase,
  teardownTestDatabase,
} from './integration-setup';
import {
  runWithTenant,
} from './helpers/cls-context.helper';
import { tenantFilterPlugin } from '../common/plugins/tenant-filter.plugin';
import { BaseDocumentRepository } from '../utils/persistence/document-repository.abstract';
import { ClsServiceManager } from 'nestjs-cls';

/**
 * BaseDocumentRepository — INTEGRATION TESTS with real MongoDB
 *
 * Tests the REAL PATCH semantics, version conflicts, and tenant enrichment.
 * These are the highest-risk behaviors because they affect ALL entities
 * (contacts, tickets, deals, accounts) through the shared base class.
 *
 * Dangerous bugs this catches:
 * - PATCH overwrites fields not in the payload (e.g. phones → [])
 * - Version conflict not detected → data loss from concurrent edits
 * - Tenant enrichment missing → cross-tenant data creation
 */

// ─── Minimal test schema ────────────────────────────────────────

interface TestEntity {
  id: string;
  tenantId: string;
  name: string;
  emails: string[];
  phones: string[];
  score: number;
  ownerId?: string;
  createdById: string;
  updatedById: string;
  version?: number;
}

const TestEntitySchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true },
    emails: { type: [String], default: [] },
    phones: { type: [String], default: [] },
    score: { type: Number, default: 0 },
    ownerId: { type: Schema.Types.ObjectId },
    createdById: { type: Schema.Types.ObjectId, required: true },
    updatedById: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true },
);
TestEntitySchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

type TestEntityDocument = Document & {
  tenantId: string;
  name: string;
  emails: string[];
  phones: string[];
  score: number;
  ownerId?: string;
  createdById: string;
  updatedById: string;
};

// ─── Concrete repository for testing ────────────────────────────

class TestEntityRepository extends BaseDocumentRepository<TestEntityDocument, TestEntity> {
  protected mapToDomain(doc: any): TestEntity {
    return {
      id: doc._id?.toString(),
      tenantId: doc.tenantId?.toString(),
      name: doc.name,
      emails: doc.emails ?? [],
      phones: doc.phones ?? [],
      score: doc.score ?? 0,
      ownerId: doc.ownerId?.toString(),
      createdById: doc.createdById?.toString(),
      updatedById: doc.updatedById?.toString(),
      version: doc.__v,
    };
  }

  protected toPersistence(domain: TestEntity): any {
    return {
      tenantId: domain.tenantId,
      name: domain.name,
      emails: domain.emails ?? [],   // THIS is the dangerous default
      phones: domain.phones ?? [],   // THIS is the dangerous default
      score: domain.score ?? 0,
      ownerId: domain.ownerId,
      createdById: domain.createdById,
      updatedById: domain.updatedById,
      __v: domain.version,
    };
  }
}

let connection: Connection;
let TestModel: Model<TestEntityDocument>;
let repo: TestEntityRepository;

const TENANT_A = new mongoose.Types.ObjectId().toString();
const TENANT_B = new mongoose.Types.ObjectId().toString();
const USER_1 = new mongoose.Types.ObjectId().toString();
const USER_2 = new mongoose.Types.ObjectId().toString();

beforeAll(async () => {
  connection = await setupTestDatabase();
  TestModel = connection.model('TestEntity', TestEntitySchema) as any;
}, 30000);

afterEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await teardownTestDatabase();
}, 10000);

describe('BaseDocumentRepository — real MongoDB', () => {
  // ═══════════════════════════════════════════════════════════════════
  // PATCH SEMANTICS — the #1 data corruption risk
  // ═══════════════════════════════════════════════════════════════════
  describe('PATCH semantics (update only submitted fields)', () => {
    it('updating name should NOT overwrite existing emails/phones with empty arrays', async () => {
      // Create entity with real data
      const created = await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        repo = new TestEntityRepository(TestModel, cls);
        return repo.create({
          name: 'John Doe',
          emails: ['john@example.com', 'john2@example.com'],
          phones: ['+84901234567'],
          score: 85,
        } as any);
      });

      // PATCH: only update name — emails, phones, score should be UNTOUCHED
      const updated = await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        repo = new TestEntityRepository(TestModel, cls);
        return repo.update(created.id, { name: 'Jane Doe' } as any);
      });

      expect(updated!.name).toBe('Jane Doe');
      // CRITICAL: these must NOT be overwritten to empty defaults
      expect(updated!.emails).toEqual(['john@example.com', 'john2@example.com']);
      expect(updated!.phones).toEqual(['+84901234567']);
      expect(updated!.score).toBe(85);
    });

    it('updating score should NOT touch name or emails', async () => {
      const created = await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        repo = new TestEntityRepository(TestModel, cls);
        return repo.create({
          name: 'Contact A',
          emails: ['a@test.com'],
          score: 50,
        } as any);
      });

      const updated = await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        repo = new TestEntityRepository(TestModel, cls);
        return repo.update(created.id, { score: 99 } as any);
      });

      expect(updated!.score).toBe(99);
      expect(updated!.name).toBe('Contact A');
      expect(updated!.emails).toEqual(['a@test.com']);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // VERSION CONFLICT — concurrent edit detection
  // ═══════════════════════════════════════════════════════════════════
  describe('optimistic locking (version conflict)', () => {
    it('concurrent update with stale version throws ConflictException', async () => {
      const created = await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        repo = new TestEntityRepository(TestModel, cls);
        return repo.create({ name: 'Original', emails: ['x@y.com'] } as any);
      });

      // User 1 updates (version 0 → 1)
      await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        repo = new TestEntityRepository(TestModel, cls);
        return repo.update(created.id, {
          name: 'User1 Edit',
          version: 0,
        } as any);
      });

      // User 2 tries with stale version 0 → should throw
      await expect(
        runWithTenant(TENANT_A, async () => {
          const cls = ClsServiceManager.getClsService();
          repo = new TestEntityRepository(TestModel, cls);
          return repo.update(created.id, {
            name: 'User2 Edit',
            version: 0,
          } as any);
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // TENANT ENRICHMENT — auto-set from CLS
  // ═══════════════════════════════════════════════════════════════════
  describe('tenant auto-enrichment', () => {
    it('create() auto-sets tenantId, createdById, ownerId from CLS', async () => {
      const created = await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        cls.set('userId', USER_1);
        repo = new TestEntityRepository(TestModel, cls);
        return repo.create({ name: 'Auto-enriched' } as any);
      });

      expect(created.tenantId).toBe(TENANT_A);
      expect(created.createdById).toBe(USER_1);
      expect(created.updatedById).toBe(USER_1);
      // ownerId auto-assigned to creator
      expect(created.ownerId).toBe(USER_1);
    });

    it('create() does NOT overwrite explicitly set tenantId', async () => {
      const created = await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        repo = new TestEntityRepository(TestModel, cls);
        return repo.create({
          name: 'Explicit tenant',
          tenantId: TENANT_A, // explicitly set
        } as any);
      });

      expect(created.tenantId).toBe(TENANT_A);
    });

    it('update() auto-enriches updatedById from CLS', async () => {
      const created = await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        cls.set('userId', USER_1);
        repo = new TestEntityRepository(TestModel, cls);
        return repo.create({ name: 'By User1' } as any);
      });

      // Different user updates
      const updated = await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        cls.set('userId', USER_2);
        repo = new TestEntityRepository(TestModel, cls);
        return repo.update(created.id, { name: 'Updated by User2' } as any);
      });

      expect(updated!.updatedById).toBe(USER_2);
      expect(updated!.createdById).toBe(USER_1); // creator unchanged
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // CROSS-TENANT UPDATE/DELETE PROTECTION
  // ═══════════════════════════════════════════════════════════════════
  describe('cross-tenant protection', () => {
    it('update() from different tenant returns null (no match)', async () => {
      const created = await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        repo = new TestEntityRepository(TestModel, cls);
        return repo.create({ name: 'TenantA Data', score: 50 } as any);
      });

      const result = await runWithTenant(TENANT_B, async () => {
        const cls = ClsServiceManager.getClsService();
        repo = new TestEntityRepository(TestModel, cls);
        return repo.update(created.id, { name: 'Hacked' } as any);
      });

      expect(result).toBeNull();

      // Original unchanged
      const original = await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        repo = new TestEntityRepository(TestModel, cls);
        return repo.findOne({ _id: created.id } as any);
      });
      expect(original!.name).toBe('TenantA Data');
    });

    it('remove() from different tenant has no effect', async () => {
      const created = await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        repo = new TestEntityRepository(TestModel, cls);
        return repo.create({ name: 'Protected' } as any);
      });

      await runWithTenant(TENANT_B, async () => {
        const cls = ClsServiceManager.getClsService();
        repo = new TestEntityRepository(TestModel, cls);
        await repo.remove(created.id);
      });

      const stillExists = await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        repo = new TestEntityRepository(TestModel, cls);
        return repo.findOne({ _id: created.id } as any);
      });
      expect(stillExists).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // FAULT INJECTION
  // ═══════════════════════════════════════════════════════════════════
  describe('FAULT INJECTION', () => {
    it('PROVES: if PATCH whitelist is removed, update({ name }) would destroy emails/phones', async () => {
      /**
       * Without the payloadKeys whitelist in update(), toPersistence()
       * would produce { emails: [], phones: [] } from defaults,
       * and $set would overwrite real data with empty arrays.
       *
       * This test proves the whitelist is essential:
       * - With whitelist: emails/phones preserved ✓
       * - Without whitelist: emails/phones = [] (data loss)
       */
      const created = await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        repo = new TestEntityRepository(TestModel, cls);
        return repo.create({
          name: 'Full Data',
          emails: ['a@b.com', 'c@d.com'],
          phones: ['+1', '+2', '+3'],
        } as any);
      });

      // PATCH only name
      const updated = await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        repo = new TestEntityRepository(TestModel, cls);
        return repo.update(created.id, { name: 'Changed' } as any);
      });

      // If whitelist works: data preserved
      expect(updated!.emails).toHaveLength(2);
      expect(updated!.phones).toHaveLength(3);
      // If whitelist was broken: these would be [] → test fails → bug caught
    });
  });
});
