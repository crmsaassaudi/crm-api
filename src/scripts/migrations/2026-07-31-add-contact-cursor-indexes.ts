/**
 * Production migration for every non-default Contact cursor sort.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register \
 *     src/scripts/migrations/2026-07-31-add-contact-cursor-indexes.ts
 *
 * The migration is idempotent and does not call syncIndexes(), so it never
 * drops an existing production index. Build on a secondary/maintenance window
 * and confirm replication lag before exposing the new sort options.
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const COLLECTION = 'contacts';
const SPECS = ['updatedAt', 'firstName', 'lastName', 'score'].map((field) => ({
  name: `tenant_active_${field}_cursor`,
  key: { tenantId: 1, [field]: 1, _id: 1 },
}));

async function backfillMissingScores(
  collection: ReturnType<
    NonNullable<typeof mongoose.connection.db>['collection']
  >,
): Promise<number> {
  let updated = 0;
  for (;;) {
    const rows = await collection
      .find(
        { $or: [{ score: { $exists: false } }, { score: null }] },
        { projection: { _id: 1 } },
      )
      .limit(5_000)
      .toArray();
    if (rows.length === 0) return updated;
    const result = await collection.updateMany(
      { _id: { $in: rows.map((row) => row._id) } },
      { $set: { score: 0 } },
    );
    updated += result.modifiedCount;
    console.log(`[backfill] Contact score: ${updated} updated`);
  }
}

async function main() {
  const uri = process.env.DATABASE_URL ?? process.env.MONGO_URL;
  if (!uri) {
    console.error('DATABASE_URL or MONGO_URL is required');
    process.exit(1);
  }

  await mongoose.connect(uri);
  try {
    const collection = mongoose.connection.db!.collection(COLLECTION);
    const scoreBackfill = await backfillMissingScores(collection);
    console.log(`[ok]   Contact score backfill: ${scoreBackfill}`);
    const existingNames = new Set(
      (await collection.indexes()).map((index) => index.name),
    );

    for (const spec of SPECS) {
      if (existingNames.has(spec.name)) {
        console.log(`[skip] ${COLLECTION}.${spec.name} already exists`);
        continue;
      }
      await collection.createIndex(spec.key as any, {
        name: spec.name,
        partialFilterExpression: { deletedAt: null },
      });
      console.log(`[ok]   ${COLLECTION}.${spec.name}`);
    }

    console.log('\nRollback (run only after disabling the matching sort):');
    for (const spec of [...SPECS].reverse()) {
      console.log(
        `db.getCollection('${COLLECTION}').dropIndex('${spec.name}')`,
      );
    }
  } finally {
    await mongoose.disconnect();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
