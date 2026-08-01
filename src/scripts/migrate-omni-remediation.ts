import 'dotenv/config';
import { MongoClient, type Db } from 'mongodb';

/**
 * Data migration for the omni communication remediation (audit 2026-07-31).
 *
 * The code changes are backward-compatible on their own, but three of them only
 * behave correctly once the existing data has caught up:
 *
 *   1. Message ordering now sorts on `providerTimestamp, sequence, _id`.
 *      Historical messages have no `sequence`, so a mixed collection would sort
 *      old messages inconsistently against new ones. Backfilled per conversation
 *      in provider-time order, which is the order the customer saw.
 *
 *   2. `omni_conversations.lastMessageSequence` is the guard that stops a late
 *      out-of-order write from overwriting a newer `lastMessage`. Without a
 *      value it is `null` and the guard is inert for that conversation.
 *
 *   3. Retired indexes. Keeping them costs write throughput on the hottest
 *      collection in the system, and `conversation_text_search` must be rebuilt
 *      because it was narrowed to `customer.name` (Mongo will not change the
 *      key spec of an existing index in place).
 *
 * Step 4 writes nothing: it reports conversations whose `channelAccount` is not
 * a channel of their own tenant. Those are the possible casualties of the
 * cross-tenant webhook leak (C9) — a batch containing events for two accounts
 * was attributed wholesale to the first one. Any hit needs a human decision,
 * never an automated rewrite.
 *
 * Idempotent: re-running skips messages that already have a sequence and
 * indexes that are already in the target shape.
 *
 *   npm run migrate:omni-remediation -- --dry-run
 *   npm run migrate:omni-remediation
 */

const DRY_RUN = process.argv.includes('--dry-run');

/** Index shapes replaced by `conversation_messages_timeline`. */
const RETIRED_MESSAGE_INDEXES = [
  'conversation_messages',
  'conversation_messages_created_cursor',
];

/** Rebuilt with a narrower key spec, so it has to be dropped first. */
const REBUILT_CONVERSATION_INDEXES: Array<{
  name: string;
  key: Record<string, any>;
}> = [
  {
    name: 'conversation_text_search',
    key: { tenantId: 1, 'customer.name': 'text' },
  },
];

const BATCH = 500;

const stats: Record<string, number> = {};

function bump(key: string, by = 1): void {
  stats[key] = (stats[key] ?? 0) + by;
}

/**
 * Assign 1..n to a conversation's messages in the order they actually happened.
 *
 * `providerTimestamp` is the customer-visible order; `createdAt` breaks ties for
 * messages the provider stamped identically, and `_id` makes the result stable
 * across re-runs.
 */
async function backfillMessageSequences(db: Db): Promise<void> {
  const messages = db.collection('omni_messages');

  const conversationIds: any[] = await messages.distinct('conversationId', {
    sequence: { $in: [null, 0] },
  });

  bump('conversations.needing_sequence', conversationIds.length);

  for (const conversationId of conversationIds) {
    const docs = await messages
      .find({ conversationId })
      .project({ _id: 1, sequence: 1 })
      .sort({ providerTimestamp: 1, createdAt: 1, _id: 1 })
      .toArray();

    const writes = docs
      .map((doc, index) => ({ doc, sequence: index + 1 }))
      .filter(({ doc, sequence }) => doc.sequence !== sequence)
      .map(({ doc, sequence }) => ({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { sequence } },
        },
      }));

    if (writes.length === 0) continue;
    bump('messages.sequenced', writes.length);

    if (DRY_RUN) continue;
    for (let i = 0; i < writes.length; i += BATCH) {
      await messages.bulkWrite(writes.slice(i, i + BATCH), { ordered: false });
    }
  }
}

/**
 * Point each conversation's `lastMessageSequence` at its highest message
 * sequence — the value the ordering guard compares incoming writes against.
 */
async function backfillLastMessageSequence(db: Db): Promise<void> {
  const conversations = db.collection('omni_conversations');
  const messages = db.collection('omni_messages');

  const cursor = conversations.find(
    { lastMessageSequence: { $in: [null, undefined] } },
    { projection: { _id: 1 } },
  );

  let writes: any[] = [];
  for await (const conversation of cursor) {
    const [newest] = await messages
      .find({ conversationId: conversation._id })
      .project({ sequence: 1 })
      .sort({ sequence: -1 })
      .limit(1)
      .toArray();

    writes.push({
      updateOne: {
        filter: { _id: conversation._id },
        update: { $set: { lastMessageSequence: newest?.sequence ?? 0 } },
      },
    });
    bump('conversations.last_sequence_set');

    if (writes.length >= BATCH) {
      if (!DRY_RUN) {
        await conversations.bulkWrite(writes, { ordered: false });
      }
      writes = [];
    }
  }

  if (writes.length > 0 && !DRY_RUN) {
    await conversations.bulkWrite(writes, { ordered: false });
  }
}

async function dropRetiredIndexes(db: Db): Promise<void> {
  const messages = db.collection('omni_messages');
  const existing = await messages.indexes();

  for (const name of RETIRED_MESSAGE_INDEXES) {
    if (!existing.some((index) => index.name === name)) continue;
    bump('indexes.dropped');
    console.log(`  drop omni_messages.${name}`);
    if (!DRY_RUN) await messages.dropIndex(name);
  }
}

/**
 * Mongo rejects `createIndex` when the name exists with a different key spec,
 * so a narrowed index has to be dropped and recreated. Recreating here rather
 * than leaving it to app start-up keeps the window without a search index down
 * to this script's runtime.
 */
async function rebuildNarrowedIndexes(db: Db): Promise<void> {
  const conversations = db.collection('omni_conversations');
  const existing = await conversations.indexes();

  for (const target of REBUILT_CONVERSATION_INDEXES) {
    const current = existing.find((index) => index.name === target.name);
    const alreadyNarrow =
      current && JSON.stringify(current.key) === JSON.stringify(target.key);
    if (alreadyNarrow) continue;

    console.log(`  rebuild omni_conversations.${target.name}`);
    bump('indexes.rebuilt');
    if (DRY_RUN) continue;

    if (current) await conversations.dropIndex(target.name);
    await conversations.createIndex(target.key as any, { name: target.name });
  }
}

/**
 * Report-only: conversations attributed to a channel account their tenant does
 * not own. Before the per-event accountId fix, a webhook batch spanning two
 * accounts was processed under the first account in the batch, so a message
 * could land in the wrong tenant's inbox.
 */
async function reportMisattributedConversations(db: Db): Promise<void> {
  const conversations = db.collection('omni_conversations');
  const channels = db.collection('channels');

  // Channel type is stored lower-case on `channels` and free-cased on the
  // conversation, the same normalisation the runtime lookup applies.
  const key = (type: unknown, account: unknown) =>
    `${String(type).toLowerCase()}:${String(account)}`;

  const owners = new Map<string, string>();
  for await (const channel of channels.find(
    {},
    { projection: { tenantId: 1, type: 1, account: 1 } },
  )) {
    if (!channel.account) continue;
    owners.set(key(channel.type, channel.account), String(channel.tenantId));
  }

  const suspects: Array<{ id: string; tenantId: string; key: string }> = [];
  for await (const conversation of conversations.find(
    {},
    { projection: { tenantId: 1, channelType: 1, channelAccount: 1 } },
  )) {
    const conversationKey = key(
      conversation.channelType,
      conversation.channelAccount,
    );
    const owner = owners.get(conversationKey);
    // An unknown account is a deleted or never-registered channel, not a leak.
    if (!owner) {
      bump('conversations.unknown_channel');
      continue;
    }
    if (owner === String(conversation.tenantId)) continue;

    bump('conversations.misattributed');
    if (suspects.length < 50) {
      suspects.push({
        id: String(conversation._id),
        tenantId: String(conversation.tenantId),
        key: conversationKey,
      });
    }
  }

  if (suspects.length === 0) {
    console.log('  none — no evidence of cross-tenant attribution');
    return;
  }

  console.log(
    `  ${stats['conversations.misattributed']} conversation(s) sit under a ` +
      'tenant that does not own their channel account:',
  );
  for (const suspect of suspects) {
    console.log(
      `    ${suspect.id}  tenant=${suspect.tenantId}  ${suspect.key}`,
    );
  }
  console.log(
    '  These need a human decision (move or delete) — this script never ' +
      'rewrites tenant ownership.',
  );
}

async function main(): Promise<void> {
  const uri = process.env.DATABASE_URL || process.env.MONGODB_URI;
  if (!uri) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    console.log(
      `Connected. Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY'}\n`,
    );

    console.log('1/5  Messages — backfilling `sequence`');
    await backfillMessageSequences(db);

    console.log('\n2/5  Conversations — backfilling `lastMessageSequence`');
    await backfillLastMessageSequence(db);

    console.log('\n3/5  Indexes — dropping retired message indexes');
    await dropRetiredIndexes(db);

    console.log('\n4/5  Indexes — rebuilding narrowed conversation indexes');
    await rebuildNarrowedIndexes(db);

    console.log('\n5/5  Scan — cross-tenant channel attribution (report only)');
    await reportMisattributedConversations(db);

    console.log('\n=== Summary ===');
    for (const [key, value] of Object.entries(stats).sort()) {
      console.log(`  ${key}: ${value}`);
    }
    if (DRY_RUN) {
      console.log('\nDRY RUN — nothing was written.');
    }
  } catch (error) {
    console.error(
      '\nMigration failed:',
      error instanceof Error ? error.stack : error,
    );
    process.exit(1);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
