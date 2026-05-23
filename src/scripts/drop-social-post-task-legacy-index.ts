import { MongoClient } from 'mongodb';

async function dropSocialPostTaskLegacyIndex() {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db();
    const collection = db.collection('social_post_tasks');
    const indexes = await collection.indexes();
    const legacyIndexName = 'tenant_post_channel_task_lookup';

    if (!indexes.some((index) => index.name === legacyIndexName)) {
      console.log(
        `Legacy index ${legacyIndexName} not found; nothing to drop.`,
      );
      return;
    }

    await collection.dropIndex(legacyIndexName);
    console.log(`Dropped legacy index ${legacyIndexName}.`);
  } finally {
    await client.close();
  }
}

dropSocialPostTaskLegacyIndex().catch((error) => {
  console.error(
    'Failed to drop legacy social post task index:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
