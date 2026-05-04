/**
 * Migration Script: Create Full-Text Search Index on email_contents
 *
 * WHY A SCRIPT?
 * Building a text index on a large collection is an expensive operation
 * that can block the database for minutes. Running it during app startup
 * (via Mongoose syncIndexes) would cause downtime in production.
 *
 * This script is designed to run:
 *   - Manually after first deployment: `npx ts-node src/scripts/create-email-text-index.ts`
 *   - Or via CI/CD pipeline as a post-deploy migration step
 *
 * IDEMPOTENT: Safe to run multiple times. Skips if index already exists.
 *
 * USAGE:
 *   DATABASE_URL=mongodb+srv://... npx ts-node src/scripts/create-email-text-index.ts
 */

import { MongoClient } from 'mongodb';

async function createEmailTextIndex() {
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
    const collection = db.collection('email_contents');

    // Check if index already exists
    const existingIndexes = await collection.indexes();
    const hasTextIndex = existingIndexes.some(
      (idx: any) => idx.name === 'email_fulltext_search',
    );

    if (hasTextIndex) {
      console.log(
        'ℹ️  Text index "email_fulltext_search" already exists. Skipping.',
      );
      return;
    }

    console.log(
      '🔨 Creating text index on email_contents (subject + textBody)...',
    );
    console.log('   This may take a while on large collections.');

    await collection.createIndex(
      { subject: 'text', textBody: 'text' },
      {
        name: 'email_fulltext_search',
        weights: { subject: 10, textBody: 1 }, // Subject matches rank higher
        default_language: 'none', // Support multi-language content
        background: true, // Build in background (allows other operations)
      },
    );

    console.log('✅ Text index "email_fulltext_search" created successfully!');
    console.log('   Weights: subject=10, textBody=1');
  } catch (error: any) {
    console.error(`❌ Migration failed: ${error.message}`);
    process.exit(1);
  } finally {
    await client.close();
    console.log('🔌 Disconnected from MongoDB');
  }
}

void createEmailTextIndex();
