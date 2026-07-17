import 'dotenv/config';
import {
  MongoClient,
  ObjectId,
  type AnyBulkWriteOperation,
  type Collection,
  type Document,
} from 'mongodb';

const BATCH_SIZE = 500;

const SCOPE_COLLECTIONS: { collection: string; scope: string }[] = [
  { collection: 'contacts', scope: 'Contact' },
  { collection: 'deals', scope: 'Deal' },
  { collection: 'tickets', scope: 'Ticket' },
  { collection: 'accounts', scope: 'Account' },
  { collection: 'omni_conversations', scope: 'Conversation' },
];

interface TenantScopeCache {
  idSet: Set<string>;
  nameToId: Map<string, string>;
}

/**
 * Historically `tags` on Contact/Deal/Ticket/Account/Conversation held free-text
 * tag names typed by users, independent of the `tags` catalog collection managed
 * by the Tags settings screen. This migration rewrites those arrays to hold the
 * catalog's `_id` instead, creating a catalog entry for any legacy name that
 * doesn't already have one. Idempotent: values that already match an existing
 * tag id for that tenant+scope are left untouched.
 */
async function loadTenantScopeCache(
  tagsCol: Collection<Document>,
  tenantId: ObjectId,
  scope: string,
): Promise<TenantScopeCache> {
  const existing = await tagsCol.find({ tenantId, scope }).toArray();
  const idSet = new Set<string>(existing.map((t) => t._id.toString()));
  const nameToId = new Map<string, string>(
    existing.map((t) => [t.name as string, t._id.toString()]),
  );
  return { idSet, nameToId };
}

async function resolveTagId(
  tagsCol: Collection<Document>,
  cache: TenantScopeCache,
  tenantId: ObjectId,
  scope: string,
  rawValue: string,
): Promise<string> {
  const cached = cache.nameToId.get(rawValue);
  if (cached) return cached;

  try {
    const insertResult = await tagsCol.insertOne({
      tenantId,
      name: rawValue,
      color: '#6b7280',
      scope,
      order: 0,
      channelIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const newId = insertResult.insertedId.toString();
    cache.nameToId.set(rawValue, newId);
    cache.idSet.add(newId);
    return newId;
  } catch (error: any) {
    // Duplicate key race (another doc in this same run just created the same name) — refetch.
    if (error?.code === 11000) {
      const found = await tagsCol.findOne({ tenantId, scope, name: rawValue });
      if (found) {
        const foundId = found._id.toString();
        cache.nameToId.set(rawValue, foundId);
        cache.idSet.add(foundId);
        return foundId;
      }
    }
    throw error;
  }
}

async function migrateScope(
  db: ReturnType<MongoClient['db']>,
  tagsCol: Collection<Document>,
  { collection, scope }: { collection: string; scope: string },
): Promise<void> {
  const col = db.collection(collection);
  const cursor = col.find({ tags: { $exists: true, $not: { $size: 0 } } });

  const tenantCaches = new Map<string, TenantScopeCache>();
  let totalDocs = 0;
  let totalTagsCreated = 0;
  let batch: AnyBulkWriteOperation[] = [];

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!doc) continue;

    const rawTags: string[] = doc.tags ?? [];
    if (!rawTags.length) continue;

    const tenantId: ObjectId = doc.tenantId;
    const tenantKey = tenantId.toString();
    let cache = tenantCaches.get(tenantKey);
    if (!cache) {
      cache = await loadTenantScopeCache(tagsCol, tenantId, scope);
      tenantCaches.set(tenantKey, cache);
    }

    let changed = false;
    const resolvedIds: string[] = [];
    for (const raw of rawTags) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      if (cache.idSet.has(raw)) {
        resolvedIds.push(raw);
        continue;
      }
      const before = cache.nameToId.size;
      const id = await resolveTagId(tagsCol, cache, tenantId, scope, raw);
      if (cache.nameToId.size > before) totalTagsCreated++;
      resolvedIds.push(id);
      changed = true;
    }

    const deduped = Array.from(new Set(resolvedIds));
    if (changed) {
      batch.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { tags: deduped } },
        },
      });
      totalDocs++;
    }

    if (batch.length >= BATCH_SIZE) {
      await col.bulkWrite(batch, { ordered: false });
      console.log(
        `    ↳ flushed batch of ${batch.length} (${totalDocs} total so far)`,
      );
      batch = [];
    }
  }

  if (batch.length > 0) {
    await col.bulkWrite(batch, { ordered: false });
  }

  console.log(
    `  ${collection} (${scope}): ${totalDocs} documents updated, ${totalTagsCreated} catalog tags created`,
  );
}

async function migrateTags() {
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
    const tagsCol = db.collection('tags');

    for (const scopeCollection of SCOPE_COLLECTIONS) {
      await migrateScope(db, tagsCol, scopeCollection);
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

migrateTags().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
