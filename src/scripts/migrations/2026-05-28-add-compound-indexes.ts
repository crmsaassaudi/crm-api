/**
 * Migration: add compound indexes for the hottest list queries.
 *
 * Why: review (2026-05-28) found list endpoints on tickets, deals,
 * conversations and contacts running with only single-field indexes,
 * which forces COLLSCAN once tenant data crosses ~100k docs.
 *
 * Strategy:
 *   1. Run with `MONGO_URL=…` env var (no app context needed).
 *   2. Each index is created with `background: true` so production write
 *      traffic is not blocked. The Mongo coordinator will refuse to add
 *      a duplicate or conflicting index, so the script is idempotent.
 *   3. After running, do `npm run ops:verify-indexes` to confirm.
 *
 * Rollback: drop by name (script prints `dropIndex(...)` line for each).
 */
import 'dotenv/config';
import mongoose, { IndexDefinition, IndexOptions } from 'mongoose';

type IndexSpec = {
  collection: string;
  name: string;
  key: IndexDefinition;
  options?: IndexOptions;
};

const indexes: IndexSpec[] = [
  // tickets — list by status / owner / contact
  {
    collection: 'tickets',
    name: 'tickets_tenant_status_createdAt',
    key: { tenantId: 1, statusId: 1, createdAt: -1 },
  },
  {
    collection: 'tickets',
    name: 'tickets_tenant_owner_status',
    key: { tenantId: 1, ownerId: 1, statusId: 1 },
  },
  {
    collection: 'tickets',
    name: 'tickets_tenant_contact_createdAt',
    key: { tenantId: 1, contactId: 1, createdAt: -1 },
  },
  // deals — list by stage / owner won
  {
    collection: 'deals',
    name: 'deals_tenant_stage_updatedAt',
    key: { tenantId: 1, stageId: 1, updatedAt: -1 },
  },
  {
    collection: 'deals',
    name: 'deals_tenant_owner_wonAt',
    key: { tenantId: 1, ownerId: 1, wonAt: -1 },
  },
  // omni_conversations — inbox queries
  {
    collection: 'omni_conversations',
    name: 'conv_tenant_status_lastMessageAt',
    key: { tenantId: 1, status: 1, lastMessageAt: -1 },
  },
  {
    collection: 'omni_conversations',
    name: 'conv_tenant_external_lookup',
    key: { tenantId: 1, externalId: 1, channelType: 1, channelAccount: 1 },
  },
  {
    collection: 'omni_conversations',
    name: 'conv_tenant_agent_status',
    key: { tenantId: 1, assignedAgentId: 1, status: 1 },
  },
  // omni_messages — message list per conversation
  {
    collection: 'omni_messages',
    name: 'msg_tenant_conversation_createdAt',
    key: { tenantId: 1, conversationId: 1, createdAt: -1 },
  },
  // contacts — list by lifecycle / status
  {
    collection: 'contacts',
    name: 'contacts_tenant_lifecycle_createdAt',
    key: { tenantId: 1, lifecycleStageId: 1, createdAt: -1 },
  },
  {
    collection: 'contacts',
    name: 'contacts_tenant_status_updatedAt',
    key: { tenantId: 1, statusId: 1, updatedAt: -1 },
  },
  // tasks — owner due-date list
  {
    collection: 'tasks',
    name: 'tasks_tenant_owner_dueDate',
    key: { tenantId: 1, ownerId: 1, dueDate: -1 },
  },
  // accounts — industry browse
  {
    collection: 'accounts',
    name: 'accounts_tenant_industry_createdAt',
    key: { tenantId: 1, industry: 1, createdAt: -1 },
  },
];

async function main() {
  const uri = process.env.DATABASE_URL ?? process.env.MONGO_URL;
  if (!uri) {
    console.error('DATABASE_URL or MONGO_URL is required');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;

  let created = 0;
  let skipped = 0;

  for (const spec of indexes) {
    try {
      const existing = await db.collection(spec.collection).indexes();
      const conflict = existing.find((idx: any) => idx.name === spec.name);
      if (conflict) {
        console.log(`[skip] ${spec.collection}.${spec.name} already exists`);
        skipped++;
        continue;
      }
      await db.collection(spec.collection).createIndex(
        spec.key as any,
        {
          name: spec.name,
          background: true,
          ...(spec.options ?? {}),
        } as any,
      );
      console.log(`[ok]   ${spec.collection}.${spec.name}`);
      created++;
    } catch (err: any) {
      console.error(
        `[fail] ${spec.collection}.${spec.name}: ${err?.message ?? err}`,
      );
    }
  }

  console.log('\nRollback commands (run only if you must roll back):');
  for (const spec of indexes) {
    console.log(
      `db.getCollection('${spec.collection}').dropIndex('${spec.name}')`,
    );
  }

  console.log(`\nCreated: ${created}, Skipped: ${skipped}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
