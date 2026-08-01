/**
 * Replace the global Contact text index with a tenant-prefixed text index.
 * MongoDB permits only one text index per collection, so this needs a planned
 * maintenance window (or a prior move to Atlas Search) because the old index
 * must be dropped before the replacement can be built.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register \
 *     src/scripts/migrations/2026-07-31-scope-contact-text-index.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const COLLECTION = 'contacts';
const INDEX_NAME = 'contact_text_search';
const KEY = {
  tenantId: 1,
  firstName: 'text',
  lastName: 'text',
  emails: 'text',
};

async function main() {
  const uri = process.env.DATABASE_URL ?? process.env.MONGO_URL;
  if (!uri) {
    console.error('DATABASE_URL or MONGO_URL is required');
    process.exit(1);
  }

  await mongoose.connect(uri);
  try {
    const collection = mongoose.connection.db!.collection(COLLECTION);
    const current = (await collection.indexes()).find(
      (index) => index.name === INDEX_NAME,
    );
    if (current?.key?.tenantId === 1) {
      console.log(
        `[skip] ${COLLECTION}.${INDEX_NAME} is already tenant scoped`,
      );
      return;
    }

    if (current) {
      console.log(`[plan] dropping global ${COLLECTION}.${INDEX_NAME}`);
      await collection.dropIndex(INDEX_NAME);
    }
    await collection.createIndex(KEY as any, {
      name: INDEX_NAME,
      default_language: 'none',
    });
    console.log(`[ok] ${COLLECTION}.${INDEX_NAME} is tenant scoped`);
  } finally {
    await mongoose.disconnect();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
