import { Connection, Model, Schema, Types } from 'mongoose';
import {
  setupTestDatabase,
  clearDatabase,
  teardownTestDatabase,
} from '../../test/integration-setup';
import { runWithTenant } from '../../test/helpers/cls-context.helper';
import { tenantFilterPlugin } from './tenant-filter.plugin';

/**
 * The tenant plugin must never widen a query while sanitising it.
 *
 * `stripTenantField` removes caller-supplied tenant predicates so the trusted one
 * from CLS cannot be overridden, and prunes objects left empty by that removal —
 * because an empty `{}` inside `$or` matches every document.
 *
 * Applied to the whole filter, that pruning also deleted predicates that were
 * empty *by intent*. The one that mattered: `{ownerId: {$in: []}}`, which data
 * visibility builds for a user entitled to see no records. `$in: []` was read as
 * "empty, drop it", which cascaded — the clause became `{}`, the `$or` around it
 * became `[]` and was dropped, the `$and` around that became `[]` and was
 * dropped — until the filter that meant "no rows" arrived at Mongo meaning "all
 * rows in the tenant".
 *
 * These tests live at the plugin level because every collection in the product
 * shares this function; a regression here leaks across all of them at once.
 */

const DocSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, required: true },
  name: { type: String, required: true },
  ownerId: { type: Schema.Types.ObjectId },
});
DocSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

describe('tenantFilterPlugin — empty predicates keep their meaning', () => {
  let connection: Connection;
  let model: Model<any>;

  const tenantA = new Types.ObjectId().toString();
  const tenantB = new Types.ObjectId().toString();
  const alice = new Types.ObjectId().toString();
  const bob = new Types.ObjectId().toString();

  beforeAll(async () => {
    connection = await setupTestDatabase();
    model = connection.model(
      'EmptyPredicateDoc',
      DocSchema,
    ) as unknown as Model<any>;
  }, 60_000);

  afterAll(async () => {
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    await clearDatabase();
    await runWithTenant(tenantA, async () => {
      await model.create([
        { tenantId: tenantA, name: 'a1', ownerId: alice },
        { tenantId: tenantA, name: 'b1', ownerId: bob },
      ] as any);
    });
    await runWithTenant(tenantB, async () => {
      await model.create([
        { tenantId: tenantB, name: 'foreign', ownerId: alice },
      ] as any);
    });
  });

  describe('an empty $in must match nothing', () => {
    it('should return no documents for a bare empty $in', async () => {
      await runWithTenant(tenantA, async () => {
        const docs = await model.find({ ownerId: { $in: [] } }).lean();
        expect(docs).toHaveLength(0);
      });
    });

    it('should return no documents for an empty $in nested in $or inside $and', async () => {
      // The exact shape `BaseDocumentRepository.applyTenantFilter` produces for a
      // user whose visible-owner set is empty.
      await runWithTenant(tenantA, async () => {
        const docs = await model
          .find({ $and: [{ $or: [{ ownerId: { $in: [] } }] }] })
          .lean();
        expect(docs).toHaveLength(0);
      });
    });

    it('should count zero for the same filter', async () => {
      await runWithTenant(tenantA, async () => {
        const count = await model.countDocuments({
          $and: [{ $or: [{ ownerId: { $in: [] } }] }],
        });
        expect(count).toBe(0);
      });
    });

    it('should narrow correctly for a NON-empty $in', async () => {
      await runWithTenant(tenantA, async () => {
        const docs = await model
          .find({ $and: [{ $or: [{ ownerId: { $in: [alice] } }] }] })
          .lean();
        expect(docs.map((d) => d.name)).toEqual(['a1']);
      });
    });
  });

  describe('the protection this pruning was written for still holds', () => {
    it('should ignore a caller-supplied tenantId and uses the CLS tenant', async () => {
      await runWithTenant(tenantA, async () => {
        // Asking for tenant B's rows from inside tenant A must return tenant A's.
        const docs = await model.find({ tenantId: tenantB } as any).lean();
        expect(docs.map((d) => d.name).sort()).toEqual(['a1', 'b1']);
      });
    });

    it('should not let a tenantId inside $or widen the query', async () => {
      // Stripping `tenantId` from this `$or` leaves `[{}]`, and `{}` in an `$or`
      // matches everything — which is why the empty-pruning exists at all.
      await runWithTenant(tenantA, async () => {
        const docs = await model
          .find({ $or: [{ tenantId: tenantB }] } as any)
          .lean();
        expect(docs.every((d) => String(d.tenantId) === tenantA)).toBe(true);
        expect(docs).toHaveLength(2);
      });
    });

    it('should keep sibling predicates when a tenantId is stripped from an $or', async () => {
      await runWithTenant(tenantA, async () => {
        const docs = await model
          .find({ $or: [{ tenantId: tenantB }, { name: 'a1' }] } as any)
          .lean();
        expect(docs.map((d) => d.name)).toEqual(['a1']);
      });
    });
  });
});
