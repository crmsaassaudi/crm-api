/**
 * Migration: backfill `ownerId` on Ownable records that currently have it
 * null/missing (C3 data-leak fix).
 *
 * Why: the data-visibility filter previously treated `ownerId: null` as
 * "visible to everyone". That leak is now closed — unowned records are hidden
 * from scoped (non-admin) users. To avoid legitimately-owned-but-unstamped
 * records silently disappearing for their real owners, backfill an owner:
 *   1. ownerId ← createdById   (the record's creator, when known)
 *   2. ownerId ← tenant.ownerId (fallback for records with no creator)
 * Records that are intentionally part of an "unassigned pool" should instead
 * rely on the data_visibility.unownedRecordsVisibleToAll tenant setting.
 *
 * Run with `DATABASE_URL=… npx ts-node src/scripts/migrations/2026-07-23-backfill-owner-id.ts`.
 * Idempotent — only touches documents where ownerId is null/missing.
 * Dry-run: pass DRY_RUN=1 to report counts without writing.
 */
import 'dotenv/config';
import mongoose from 'mongoose';

// Ownable collections whose repositories enable data-visibility scoping.
const COLLECTIONS = ['contacts', 'tickets', 'deals', 'accounts', 'tasks'];

async function main() {
  const uri = process.env.DATABASE_URL ?? process.env.MONGO_URL;
  if (!uri) {
    console.error('DATABASE_URL or MONGO_URL is required');
    process.exit(1);
  }
  const dryRun = process.env.DRY_RUN === '1';

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;

  // Preload tenant owners once.
  const tenants = await db
    .collection('tenants')
    .find({}, { projection: { ownerId: 1 } })
    .toArray();
  const tenantOwner = new Map<string, any>();
  for (const t of tenants) {
    if (t.ownerId) tenantOwner.set(String(t._id), t.ownerId);
  }

  const unowned = { $or: [{ ownerId: null }, { ownerId: { $exists: false } }] };

  for (const col of COLLECTIONS) {
    const coll = db.collection(col);
    const total = await coll.countDocuments(unowned);
    if (total === 0) {
      console.log(`[skip] ${col}: no unowned records`);
      continue;
    }

    // Step 1: ownerId ← createdById where creator is known.
    let step1 = 0;
    if (!dryRun) {
      const res = await coll.updateMany(
        { ...unowned, createdById: { $ne: null, $exists: true } },
        [{ $set: { ownerId: '$createdById' } }],
      );
      step1 = res.modifiedCount;
    } else {
      step1 = await coll.countDocuments({
        ...unowned,
        createdById: { $ne: null, $exists: true },
      });
    }

    // Step 2: remaining unowned → tenant.ownerId, grouped per tenant.
    let step2 = 0;
    const remaining = await coll
      .aggregate([{ $match: unowned }, { $group: { _id: '$tenantId' } }])
      .toArray();
    for (const row of remaining) {
      const owner = tenantOwner.get(String(row._id));
      if (!owner) {
        const cnt = await coll.countDocuments({
          ...unowned,
          tenantId: row._id,
        });
        console.warn(
          `[warn] ${col}: ${cnt} records under tenant ${row._id} have no owner and tenant has no ownerId — left unowned (admin-only)`,
        );
        continue;
      }
      if (!dryRun) {
        const res = await coll.updateMany(
          { ...unowned, tenantId: row._id },
          { $set: { ownerId: owner } },
        );
        step2 += res.modifiedCount;
      } else {
        step2 += await coll.countDocuments({ ...unowned, tenantId: row._id });
      }
    }

    console.log(
      `[${dryRun ? 'dry' : 'ok'}]  ${col}: ${total} unowned → ${step1} by creator, ${step2} by tenant owner`,
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
