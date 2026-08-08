import mongoose, { Schema, Model, Connection, Document } from 'mongoose';
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  setupTestDatabase,
  clearDatabase,
  teardownTestDatabase,
} from './integration-setup';
import { runWithTenant } from './helpers/cls-context.helper';
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

// Minimal test schema

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

// Concrete repository for testing

class TestEntityRepository extends BaseDocumentRepository<
  TestEntityDocument,
  TestEntity
> {
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
      emails: domain.emails ?? [], // THIS is the dangerous default
      phones: domain.phones ?? [], // THIS is the dangerous default
      score: domain.score ?? 0,
      ownerId: domain.ownerId,
      createdById: domain.createdById,
      updatedById: domain.updatedById,
      __v: domain.version,
    };
  }
}

// A second entity that soft-deletes
//
// The entity above has no `deletedAt`, so it only ever exercises the hard-delete
// branch. Soft delete is derived from the schema (`model.schema.path('deletedAt')`),
// so the two branches are genuinely different code paths — and the reversible one,
// which is the whole justification for soft delete, was never executed against a real
// database until these tests.

const SoftEntitySchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true },
    ownerId: { type: Schema.Types.ObjectId },
    createdById: { type: Schema.Types.ObjectId, required: true },
    updatedById: { type: Schema.Types.ObjectId, required: true },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);
SoftEntitySchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

class SoftEntityRepository extends BaseDocumentRepository<any, any> {
  protected mapToDomain(doc: any) {
    return {
      id: doc._id?.toString(),
      tenantId: doc.tenantId?.toString(),
      name: doc.name,
      deletedAt: doc.deletedAt ?? null,
    };
  }

  protected toPersistence(domain: any) {
    return {
      tenantId: domain.tenantId,
      name: domain.name,
      createdById: domain.createdById,
      updatedById: domain.updatedById,
    };
  }
}

let SoftModel: Model<any>;

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
  SoftModel = connection.model('SoftEntity', SoftEntitySchema) as any;
}, 30000);

afterEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await teardownTestDatabase();
}, 10000);

describe('BaseDocumentRepository — real MongoDB', () => {
  // PATCH SEMANTICS — the #1 data corruption risk
  describe('PATCH semantics (update only submitted fields)', () => {
    it('should updating name should NOT overwrite existing emails/phones with empty arrays', async () => {
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
      expect(updated!.emails).toEqual([
        'john@example.com',
        'john2@example.com',
      ]);
      expect(updated!.phones).toEqual(['+84901234567']);
      expect(updated!.score).toBe(85);
    });

    it('should updating score should NOT touch name or emails', async () => {
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

  // VERSION CONFLICT — concurrent edit detection
  describe('optimistic locking (version conflict)', () => {
    it('should concurrent update with stale version throws ConflictException', async () => {
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

  // TENANT ENRICHMENT — auto-set from CLS
  describe('tenant auto-enrichment', () => {
    it('should create() auto-sets tenantId, createdById, ownerId from CLS', async () => {
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

    it('should create() does NOT overwrite explicitly set tenantId', async () => {
      const created = await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        repo = new TestEntityRepository(TestModel, cls);
        return repo.create({
          name: 'Explicit tenant',
          tenantId: TENANT_A,
        } as any);
      });

      expect(created.tenantId).toBe(TENANT_A);
    });

    it('should update() auto-enriches updatedById from CLS', async () => {
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

  // CROSS-TENANT UPDATE/DELETE PROTECTION
  describe('cross-tenant protection', () => {
    it('should refuse update() from a different tenant with a 404', async () => {
      const created = await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        repo = new TestEntityRepository(TestModel, cls);
        return repo.create({ name: 'TenantA Data', score: 50 } as any);
      });

      // Used to resolve to `null`, which callers doing `return updated!`
      // forwarded as a 200 with an empty body — a refused write reported as a
      // successful one.
      await expect(
        runWithTenant(TENANT_B, async () => {
          const cls = ClsServiceManager.getClsService();
          repo = new TestEntityRepository(TestModel, cls);
          return repo.update(created.id, { name: 'Hacked' } as any);
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Original unchanged
      const original = await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        repo = new TestEntityRepository(TestModel, cls);
        return repo.findOne({ _id: created.id } as any);
      });
      expect(original!.name).toBe('TenantA Data');
    });

    it('should refuse remove() from a different tenant with a 404 and leave the row intact', async () => {
      const created = await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        repo = new TestEntityRepository(TestModel, cls);
        return repo.create({ name: 'Protected' } as any);
      });

      // Used to resolve silently, so the handler answered 204 No Content for a
      // record it had not deleted and was never allowed to touch.
      await expect(
        runWithTenant(TENANT_B, async () => {
          const cls = ClsServiceManager.getClsService();
          repo = new TestEntityRepository(TestModel, cls);
          await repo.remove(created.id);
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      const stillExists = await runWithTenant(TENANT_A, async () => {
        const cls = ClsServiceManager.getClsService();
        repo = new TestEntityRepository(TestModel, cls);
        return repo.findOne({ _id: created.id } as any);
      });
      expect(stillExists).not.toBeNull();
    });
  });

  describe('FAULT INJECTION', () => {
    it('should PROVES: if PATCH whitelist is removed, update({ name }) would destroy emails/phones', async () => {
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
  describe('soft delete, recycle bin and restore', () => {
    /** A repository bound to the CLS context of the current run. */
    const softRepo = () =>
      new SoftEntityRepository(
        SoftModel as any,
        ClsServiceManager.getClsService() as any,
      );

    const seedDeleted = async (name: string) =>
      runWithTenant(TENANT_A, async () => {
        const repository = softRepo();
        const created = await repository.create({ name } as any);
        await repository.remove(created.id);
        return created;
      });

    it('should STAMP deletedAt instead of destroying the row', async () => {
      const created = await seedDeleted('Doomed');

      // The row survives — the entire promise of soft delete, and never verified
      // against a real database before this test.
      const raw = await SoftModel.findById(created.id)
        .setOptions({ isPlatformQuery: true })
        .lean()
        .exec();
      expect(raw).toBeTruthy();
      expect((raw as any).deletedAt).toBeInstanceOf(Date);
    });

    it('should list a deleted record in the recycle bin', async () => {
      const created = await seedDeleted('Doomed');

      const bin = await runWithTenant(TENANT_A, () =>
        softRepo().findDeleted({ page: 1, limit: 25 }),
      );

      expect(bin.total).toBe(1);
      expect(bin.data.map((r: any) => r.id)).toEqual([created.id]);
    });

    it('should NOT list a live record in the recycle bin', async () => {
      const bin = await runWithTenant(TENANT_A, async () => {
        const repository = softRepo();
        await repository.create({ name: 'Alive' } as any);
        return repository.findDeleted({ page: 1, limit: 25 });
      });

      // `deletedAt: { $ne: null }` must not match a document with no such field. If it
      // did, the bin would list the entire live collection with a restore button.
      expect(bin.total).toBe(0);
      expect(bin.data).toEqual([]);
    });

    it('should not show one tenant the other tenant recycle bin', async () => {
      await seedDeleted('Doomed');

      const bin = await runWithTenant(
        TENANT_B,
        () => softRepo().findDeleted({ page: 1, limit: 25 }),
        USER_2,
      );

      expect(bin.total).toBe(0);
      expect(bin.data).toEqual([]);
    });

    it('should UNSET deletedAt on restore rather than writing null', async () => {
      const created = await seedDeleted('Doomed');

      const restored = await runWithTenant(TENANT_A, () =>
        softRepo().restore(created.id),
      );
      expect(restored).toBeTruthy();

      // Several repositories filter with `deletedAt: { $exists: false }`, which reads a
      // present-but-null field as still deleted. Restoring to null would leave the
      // record restored in the database and still invisible in the UI.
      const raw = await SoftModel.findById(created.id)
        .setOptions({ isPlatformQuery: true })
        .lean()
        .exec();
      expect(
        Object.prototype.hasOwnProperty.call(raw as object, 'deletedAt'),
      ).toBe(false);

      const bin = await runWithTenant(TENANT_A, () =>
        softRepo().findDeleted({ page: 1, limit: 25 }),
      );
      expect(bin.total).toBe(0);
    });

    it('should refuse to restore across a tenant boundary', async () => {
      const created = await seedDeleted('Doomed');

      const restored = await runWithTenant(
        TENANT_B,
        () => softRepo().restore(created.id),
        USER_2,
      );

      // Restore is a write that re-exposes data, so it is tenant-scoped like any
      // other. Null lets the service answer 404 instead of leaking the record.
      expect(restored).toBeNull();
      const raw = await SoftModel.findById(created.id)
        .setOptions({ isPlatformQuery: true })
        .lean()
        .exec();
      expect((raw as any).deletedAt).toBeInstanceOf(Date);
    });

    it('should return null when restoring a record that was never deleted', async () => {
      const restored = await runWithTenant(TENANT_A, async () => {
        const repository = softRepo();
        const created = await repository.create({ name: 'Alive' } as any);
        return repository.restore(created.id);
      });

      // The filter is `deletedAt: { $ne: null }`, so a live record is not a match.
      // Returning it would make restore a no-op that reports success.
      expect(restored).toBeNull();
    });

    it('should page the recycle bin newest-deletion-first', async () => {
      const { second, page } = await runWithTenant(TENANT_A, async () => {
        const repository = softRepo();
        const first = await repository.create({ name: 'First' } as any);
        const later = await repository.create({ name: 'Second' } as any);

        await repository.remove(first.id);
        // Distinct timestamps: two deletions inside the same millisecond would make
        // the ordering assertion depend on natural order instead of on the sort.
        await new Promise((resolve) => setTimeout(resolve, 10));
        await repository.remove(later.id);

        return {
          second: later,
          page: await repository.findDeleted({ page: 1, limit: 1 }),
        };
      });

      // A recycle bin is opened to undo what just happened.
      expect(page.total).toBe(2);
      expect(page.data.map((r: any) => r.id)).toEqual([second.id]);
    });

    it('should report an empty bin for a collection that hard-deletes', async () => {
      // TestEntity has no `deletedAt`, so `remove()` destroys the row and there is
      // nothing to list. Empty rather than everything is the fail-safe direction: a
      // shared recycle-bin page pointed at a hard-deleting domain must not turn into a
      // list of live records offering to restore them.
      const { created, bin } = await runWithTenant(TENANT_A, async () => {
        const repository = new TestEntityRepository(
          TestModel,
          ClsServiceManager.getClsService(),
        );
        const entity = await repository.create({ name: 'Hard' } as any);
        await repository.remove(entity.id);
        return {
          created: entity,
          bin: await repository.findDeleted({ page: 1, limit: 25 }),
        };
      });

      expect(bin).toEqual({ data: [], total: 0 });
      expect(
        await TestModel.findById(created.id)
          .setOptions({ isPlatformQuery: true })
          .lean()
          .exec(),
      ).toBeNull();
    });
  });
});
