/**
 * Migration Script: Strip '+' prefix from all phone numbers.
 *
 * WHY:
 * Phone numbers were previously stored with '+' prefix (e.g. "+84911019999").
 * The new convention is digits-only (e.g. "0911019999").
 * This script normalizes all existing phone data across contacts and accounts.
 *
 * STRATEGY: bulkWrite in batches of 500 for optimal throughput.
 * IDEMPOTENT: Safe to run multiple times. Phones without '+' are untouched.
 *
 * USAGE:
 *   npm run migrate:phone-strip-plus
 */

import 'dotenv/config';
import { MongoClient, type AnyBulkWriteOperation } from 'mongodb';

const BATCH_SIZE = 500;

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
    const collections = ['contacts', 'accounts'];

    for (const collName of collections) {
      const collection = db.collection(collName);

      // Find documents where any phone contains '+'
      const cursor = collection.find({
        phones: { $regex: /\+/ },
      });

      let totalDocs = 0;
      let totalPhones = 0;
      let batch: AnyBulkWriteOperation[] = [];

      while (await cursor.hasNext()) {
        const doc = await cursor.next();
        if (!doc) continue;

        const phones: string[] = doc.phones || [];
        let changed = false;
        const cleaned = phones.map((phone: string) => {
          if (typeof phone === 'string' && phone.includes('+')) {
            changed = true;
            totalPhones++;
            return phone.replace(/[^0-9]/g, '');
          }
          return phone;
        });

        if (changed) {
          batch.push({
            updateOne: {
              filter: { _id: doc._id },
              update: { $set: { phones: cleaned } },
            },
          });
          totalDocs++;
        }

        // Flush batch when full
        if (batch.length >= BATCH_SIZE) {
          await collection.bulkWrite(batch, { ordered: false });
          console.log(`    ↳ flushed batch of ${batch.length} (${totalDocs} total so far)`);
          batch = [];
        }
      }

      // Flush remaining
      if (batch.length > 0) {
        await collection.bulkWrite(batch, { ordered: false });
      }

      console.log(`  ${collName}: ${totalDocs} documents updated, ${totalPhones} phones cleaned`);
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
