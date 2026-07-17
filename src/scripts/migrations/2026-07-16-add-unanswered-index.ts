/**
 * Migration: add compound index backing the "Unanswered conversations" filter.
 *
 * Why: the new `unansweredMode` filter (recent / longestWaiting / readNotReplied)
 * queries by { tenantId, status, lastMessageSenderType } and sorts by
 * lastMessageAt (asc or desc) — without this index it falls back to the
 * broader `conv_tenant_status_lastMessageAt` index and scans rows that don't
 * match lastMessageSenderType.
 *
 * Run with `MONGO_URL=… npx ts-node src/scripts/migrations/2026-07-16-add-unanswered-index.ts`.
 * Idempotent — Mongo refuses to recreate an index with the same name.
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const COLLECTION = 'omni_conversations';
const INDEX_NAME = 'conversation_unanswered';
const KEY = {
  tenantId: 1,
  status: 1,
  lastMessageSenderType: 1,
  lastMessageAt: -1,
};

async function main() {
  const uri = process.env.DATABASE_URL ?? process.env.MONGO_URL;
  if (!uri) {
    console.error('DATABASE_URL or MONGO_URL is required');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;

  const existing = await db.collection(COLLECTION).indexes();
  if (existing.find((idx: any) => idx.name === INDEX_NAME)) {
    console.log(`[skip] ${COLLECTION}.${INDEX_NAME} already exists`);
  } else {
    await db
      .collection(COLLECTION)
      .createIndex(KEY as any, { name: INDEX_NAME, background: true });
    console.log(`[ok]   ${COLLECTION}.${INDEX_NAME}`);
  }

  console.log('\nRollback:');
  console.log(`db.getCollection('${COLLECTION}').dropIndex('${INDEX_NAME}')`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
