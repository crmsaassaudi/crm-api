/**
 * Drop stale index `tenant_1_shortcut_1` from canned_responses collection.
 *
 * The schema uses field `tenantId` but MongoDB has an old index on `tenant`,
 * causing duplicate key errors (every doc has tenant: null).
 *
 * Usage:  node scripts/drop-stale-index.js
 */
const { MongoClient } = require('mongodb');

const uri =
  process.env.DATABASE_URL ||
  'mongodb+srv://nguyentoan102002_db_user:Xq0t6ZsieMIelTiz@crm.sfh1nlk.mongodb.net/crm?appName=crm';

const STALE_INDEXES = ['tenant_1_shortcut_1', 'tenant_1'];
const COLLECTION = 'canned_responses';

async function main() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    const db = client.db(); // uses db from connection string
    const col = db.collection(COLLECTION);

    // List current indexes
    const indexes = await col.indexes();
    console.log(`\n📋 Current indexes on "${COLLECTION}":`);
    indexes.forEach((idx) => console.log(`   - ${idx.name}:`, JSON.stringify(idx.key)));

    const staleFound = indexes.filter((idx) => STALE_INDEXES.includes(idx.name));
    if (staleFound.length === 0) {
      console.log(`\n⚠️  No stale indexes found — nothing to drop.`);
      return;
    }

    for (const idx of staleFound) {
      console.log(`\n🗑️  Dropping stale index "${idx.name}"...`);
      await col.dropIndex(idx.name);
      console.log(`✅ Index "${idx.name}" dropped successfully!`);
    }

    // Show updated indexes
    const updatedIndexes = await col.indexes();
    console.log(`\n📋 Remaining indexes on "${COLLECTION}":`);
    updatedIndexes.forEach((idx) => console.log(`   - ${idx.name}:`, JSON.stringify(idx.key)));
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    await client.close();
    console.log('\n🔒 Connection closed.');
  }
}

main();
