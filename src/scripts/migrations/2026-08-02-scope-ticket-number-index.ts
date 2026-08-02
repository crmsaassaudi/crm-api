/**
 * Replaces the global ticketNumber unique index with tenant-scoped uniqueness.
 * Run before deploying the schema change. The legacy non-unique compound key
 * must be removed before MongoDB can create the same key as unique; the global
 * unique index remains in place during that short window and still prevents
 * duplicates. Idempotent and never uses syncIndexes.
 *
 * Run:
 *   npm run migrate:ticket-number-index
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const COLLECTION = 'tickets';
const TARGET = 'tenant_ticket_number_unique';

async function main() {
  const uri = process.env.DATABASE_URL ?? process.env.MONGO_URL;
  if (!uri) throw new Error('DATABASE_URL or MONGO_URL is required');
  await mongoose.connect(uri);
  try {
    const db = mongoose.connection.db!;
    const collection = db.collection(COLLECTION);
    // Name the database and the row count out loud: a URI without a path lands
    // on `test`, where every count is zero and the migration "succeeds" against
    // a database nobody uses.
    console.log(
      `[db] ${db.databaseName} — ${await collection.countDocuments()} ticket(s)`,
    );
    const duplicates = await collection
      .aggregate([
        {
          $group: {
            _id: { tenantId: '$tenantId', ticketNumber: '$ticketNumber' },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
        { $limit: 1 },
      ])
      .toArray();
    if (duplicates.length > 0) {
      throw new Error(
        'Duplicate ticket numbers exist inside a tenant; repair them before migration',
      );
    }

    let indexes = await collection.indexes();
    const legacyCompound = indexes.find(
      (index) =>
        index.name !== TARGET &&
        Object.keys(index.key).length === 2 &&
        index.key.tenantId === 1 &&
        index.key.ticketNumber === 1,
    );
    if (legacyCompound?.name) {
      await collection.dropIndex(legacyCompound.name);
      console.log(`[ok] dropped ${COLLECTION}.${legacyCompound.name}`);
      indexes = await collection.indexes();
    }
    if (!indexes.some((index) => index.name === TARGET)) {
      await collection.createIndex(
        { tenantId: 1, ticketNumber: 1 },
        { unique: true, name: TARGET },
      );
      console.log(`[ok] ${COLLECTION}.${TARGET}`);
    }

    indexes = await collection.indexes();
    const legacy = indexes.find(
      (index) =>
        index.unique === true &&
        Object.keys(index.key).length === 1 &&
        index.key.ticketNumber === 1,
    );
    if (legacy?.name) {
      await collection.dropIndex(legacy.name);
      console.log(`[ok] dropped ${COLLECTION}.${legacy.name}`);
    }

    console.log(
      `Rollback: db.getCollection('${COLLECTION}').dropIndex('${TARGET}')`,
    );
  } finally {
    await mongoose.disconnect();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
