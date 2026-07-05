import 'dotenv/config';
import {
  MongoClient,
  type AnyBulkWriteOperation,
  type Collection,
} from 'mongodb';

const BATCH_SIZE = 500;

/** Strip non-digit characters from phones that contain '+'. Returns null if unchanged. */
function buildPhonePatch(
  doc: any,
  totalPhones: { count: number },
): { cleaned: string[]; changed: boolean } {
  const phones: string[] = doc.phones ?? [];
  let changed = false;
  const cleaned = phones.map((phone: string) => {
    if (typeof phone === 'string' && phone.includes('+')) {
      changed = true;
      totalPhones.count++;
      return phone.replace(/\D/g, '');
    }
    return phone;
  });
  return { cleaned, changed };
}

/** Flush a batch of write operations and reset the batch array. */
async function flushBatch(
  collection: Collection,
  batch: AnyBulkWriteOperation[],
  totalDocs: number,
): Promise<void> {
  await collection.bulkWrite(batch, { ordered: false });
  console.log(
    `    ↳ flushed batch of ${batch.length} (${totalDocs} total so far)`,
  );
}

async function migrateCollection(
  collection: Collection,
  collName: string,
): Promise<void> {
  const cursor = collection.find({ phones: { $regex: /\+/ } });

  let totalDocs = 0;
  const totalPhones = { count: 0 };
  let batch: AnyBulkWriteOperation[] = [];

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!doc) continue;

    const { cleaned, changed } = buildPhonePatch(doc, totalPhones);

    if (changed) {
      batch.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { phones: cleaned } },
        },
      });
      totalDocs++;
    }

    if (batch.length >= BATCH_SIZE) {
      await flushBatch(collection, batch, totalDocs);
      batch = [];
    }
  }

  if (batch.length > 0) {
    await collection.bulkWrite(batch, { ordered: false });
  }

  console.log(
    `  ${collName}: ${totalDocs} documents updated, ${totalPhones.count} phones cleaned`,
  );
}

async function migratePhones() {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log('✅ Connected to MongoDB\n');

    const db = client.db();
    for (const collName of ['contacts', 'accounts']) {
      await migrateCollection(db.collection(collName), collName);
    }

    console.log('\n=== Migration Complete ===');
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

migratePhones().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
