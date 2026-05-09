/**
 * Migration Script: Normalize ChannelType to lowercase
 *
 * WHY THIS SCRIPT?
 * Previously, channel types were stored in PascalCase (Facebook, Zalo, Email, etc.)
 * in the MongoDB schema. We've normalized them to lowercase (facebook, zalo, email, etc.)
 * to match the TypeScript domain model and improve consistency.
 *
 * This script updates all existing documents:
 *   - omni_conversations: channelType field
 *   - omni_messages: channelType field
 *   - activity_logs: channelType field (if applicable)
 *
 * IDEMPOTENT: Safe to run multiple times. Converts and skips already-lowercase values.
 *
 * USAGE:
 *   DATABASE_URL=mongodb+srv://... npx ts-node src/scripts/migrate-channel-types-to-lowercase.ts
 *
 * EXPECTED OUTPUT:
 *   ✅ Connected to MongoDB
 *   📊 Migrating omni_conversations...
 *   ✅ Updated 123 omni_conversations
 *   📊 Migrating omni_messages...
 *   ✅ Updated 456 omni_messages
 *   ✅ Migration completed successfully
 */

import { MongoClient } from 'mongodb';

const CHANNEL_TYPE_MAP: Record<string, string> = {
  Facebook: 'facebook',
  Zalo: 'zalo',
  WhatsApp: 'whatsapp',
  LiveChat: 'livechat',
  Instagram: 'instagram',
  TikTok: 'tiktok',
  Email: 'email',
  // Lowercase versions (already migrated)
  facebook: 'facebook',
  zalo: 'zalo',
  whatsapp: 'whatsapp',
  livechat: 'livechat',
  instagram: 'instagram',
  tiktok: 'tiktok',
  email: 'email',
};

async function migrateChannelTypesToLowercase() {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error('❌ DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    const db = client.db(); // Uses the DB name from the connection string

    // ─── Migrate omni_conversations ────────────────────────────────────────
    console.log('\n📊 Migrating omni_conversations...');
    const conversationsResult = await migrateCollection(
      db,
      'omni_conversations',
    );
    console.log(
      `✅ Updated ${conversationsResult.modifiedCount} omni_conversations`,
    );
    if (conversationsResult.errors.length > 0) {
      console.warn('⚠️  Errors during conversations migration:');
      conversationsResult.errors.forEach((err) => console.warn(`  - ${err}`));
    }

    // ─── Migrate omni_messages ─────────────────────────────────────────────
    console.log('\n📊 Migrating omni_messages...');
    const messagesResult = await migrateCollection(db, 'omni_messages');
    console.log(`✅ Updated ${messagesResult.modifiedCount} omni_messages`);
    if (messagesResult.errors.length > 0) {
      console.warn('⚠️  Errors during messages migration:');
      messagesResult.errors.forEach((err) => console.warn(`  - ${err}`));
    }

    // ─── Summary ───────────────────────────────────────────────────────────
    const totalUpdated =
      conversationsResult.modifiedCount + messagesResult.modifiedCount;
    console.log('\n✅ Migration completed successfully');
    console.log(`📈 Total documents updated: ${totalUpdated}`);
  } catch (error) {
    console.error(
      '❌ Migration failed:',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  } finally {
    await client.close();
  }
}

async function migrateCollection(
  db: any,
  collectionName: string,
): Promise<{ modifiedCount: number; errors: string[] }> {
  const collection = db.collection(collectionName);
  const errors: string[] = [];
  let modifiedCount = 0;

  try {
    // Find all documents with non-lowercase channelType
    const docs = await collection
      .find({
        channelType: {
          $in: [
            'Facebook',
            'Zalo',
            'WhatsApp',
            'LiveChat',
            'Instagram',
            'TikTok',
            'Email',
          ],
        },
      })
      .toArray();

    console.log(`  📋 Found ${docs.length} documents to migrate`);

    // Batch update operations for better performance
    const bulkOps: any[] = [];

    for (const doc of docs) {
      const oldValue = doc.channelType;
      const newValue = CHANNEL_TYPE_MAP[oldValue];

      if (newValue && oldValue !== newValue) {
        bulkOps.push({
          updateOne: {
            filter: { _id: doc._id },
            update: { $set: { channelType: newValue } },
          },
        });
      }
    }

    // Execute bulk updates
    if (bulkOps.length > 0) {
      const result = await collection.bulkWrite(bulkOps);
      modifiedCount = result.modifiedCount;
      console.log(`  ✨ Bulk updated ${modifiedCount} documents`);
    } else {
      console.log(`  ℹ️  No documents needed updating`);
    }
  } catch (error) {
    const errorMsg =
      error instanceof Error ? error.message : JSON.stringify(error);
    errors.push(`${collectionName}: ${errorMsg}`);
  }

  return { modifiedCount, errors };
}

// Run the migration
migrateChannelTypesToLowercase().catch((error) => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});
