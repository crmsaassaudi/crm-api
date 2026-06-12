/**
 * Migration Script: Rename legacy tenant field to tenantId.
 *
 * WHY:
 * Older routing/automation records used `tenant` as the physical tenant key.
 * The platform convention is now `tenantId` with an ObjectId reference to
 * TenantSchemaClass. This migration is idempotent and safe to run multiple
 * times before deploying the schema change.
 *
 * USAGE:
 *   DATABASE_URL=mongodb://... npx ts-node src/scripts/migrate-tenant-to-tenant-id.ts
 */

import { MongoClient, ObjectId } from 'mongodb';

const COLLECTIONS = ['automation_rules', 'routing_rules'] as const;

async function migrateTenantToTenantId() {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log('Connected to MongoDB');

    const db = client.db();
    let totalMigrated = 0;
    let totalCleaned = 0;

    for (const collectionName of COLLECTIONS) {
      const { migrated, cleaned } = await migrateCollection(
        db.collection(collectionName),
        collectionName,
      );
      totalMigrated += migrated;
      totalCleaned += cleaned;
    }

    console.log('Migration completed successfully');
    console.log(`Documents migrated: ${totalMigrated}`);
    console.log(`Legacy fields cleaned: ${totalCleaned}`);
  } catch (error) {
    console.error(
      'Migration failed:',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  } finally {
    await client.close();
  }
}

async function migrateCollection(collection: any, collectionName: string) {
  const BATCH_SIZE = 1000;
  let migrated = 0;
  let skipped = 0;

  // LOW-08: Use cursor-based batching to avoid loading all docs into memory
  const cursor = collection
    .find({
      tenant: { $exists: true, $ne: null },
      tenantId: { $exists: false },
    })
    .project({ _id: 1, tenant: 1 })
    .batchSize(BATCH_SIZE);

  let bulkOps: any[] = [];

  for await (const doc of cursor) {
    const tenantId = normalizeTenantId(doc.tenant);
    if (!tenantId) {
      skipped += 1;
      console.warn(
        `${collectionName}: skipped ${String(doc._id)} because tenant is not a valid ObjectId`,
      );
      continue;
    }

    bulkOps.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { tenantId }, $unset: { tenant: '' } },
      },
    });

    // Flush batch when it reaches BATCH_SIZE
    if (bulkOps.length >= BATCH_SIZE) {
      const result = await collection.bulkWrite(bulkOps, { ordered: false });
      migrated += result.modifiedCount;
      console.log(
        `${collectionName}: batch flushed — ${result.modifiedCount} migrated (total: ${migrated})`,
      );
      bulkOps = [];
    }
  }

  // Flush remaining
  if (bulkOps.length > 0) {
    const result = await collection.bulkWrite(bulkOps, { ordered: false });
    migrated += result.modifiedCount;
  }

  const cleanupResult = await collection.updateMany(
    {
      tenant: { $exists: true },
      tenantId: { $exists: true },
    },
    { $unset: { tenant: '' } },
  );

  console.log(
    `${collectionName}: migrated=${migrated}, cleaned=${cleanupResult.modifiedCount}, skipped=${skipped}`,
  );

  return {
    migrated,
    cleaned: cleanupResult.modifiedCount,
  };
}

function normalizeTenantId(value: unknown): ObjectId | null {
  if (value instanceof ObjectId) {
    return value;
  }

  const stringValue = String(value);
  if (!ObjectId.isValid(stringValue)) {
    return null;
  }

  return new ObjectId(stringValue);
}

migrateTenantToTenantId().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
