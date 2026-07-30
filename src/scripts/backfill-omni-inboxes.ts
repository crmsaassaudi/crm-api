/**
 * Idempotent Inbox backfill.
 *
 * For each tenant with Omni channels, creates one legacy/default Inbox, binds
 * unbound channels to it, then snapshots the channel's Inbox onto historical
 * conversations. Existing explicit Inbox assignments are never overwritten.
 *
 * Usage:
 *   npm run backfill:omni-inboxes -- --dry-run
 *   npm run backfill:omni-inboxes
 */
import 'dotenv/config';
import mongoose from 'mongoose';

async function main() {
  const uri = process.env.DATABASE_URL ?? process.env.MONGO_URL;
  if (!uri) throw new Error('DATABASE_URL or MONGO_URL is required');
  const dryRun = process.argv.includes('--dry-run');

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  const channels = db.collection('channels');
  const inboxes = db.collection('omni_inboxes');
  const conversations = db.collection('omni_conversations');
  const tenantRows = await channels
    .aggregate([{ $group: { _id: '$tenantId' } }])
    .toArray();

  for (const row of tenantRows) {
    const tenantId = row._id;
    let inbox = await inboxes.findOne({ tenantId, key: 'legacy-default' });
    if (!inbox && !dryRun) {
      const now = new Date();
      const result = await inboxes.insertOne({
        tenantId,
        key: 'legacy-default',
        name: 'Default Inbox',
        status: 'active',
        visibilityMode: 'open',
        groupIds: [],
        userIds: [],
        routingRuleId: null,
        slaPolicyId: null,
        botPolicyId: null,
        businessHoursId: null,
        createdAt: now,
        updatedAt: now,
      });
      inbox = { _id: result.insertedId };
    }

    const unbound = await channels
      .find(
        {
          tenantId,
          $or: [{ inboxId: null }, { inboxId: { $exists: false } }],
        },
        { projection: { _id: 1 } },
      )
      .toArray();
    const inboxId = inbox?._id;
    if (!dryRun && inboxId && unbound.length) {
      await channels.updateMany(
        { _id: { $in: unbound.map((item) => item._id) }, tenantId },
        { $set: { inboxId, updatedAt: new Date() } },
      );
    }

    let conversationCount = 0;
    const tenantChannels = await channels
      .find(
        { tenantId, inboxId: { $ne: null } },
        { projection: { _id: 1, inboxId: 1 } },
      )
      .toArray();
    for (const channel of tenantChannels) {
      const filter = {
        tenantId,
        channelId: channel._id,
        $or: [{ inboxId: null }, { inboxId: { $exists: false } }],
      };
      if (dryRun) {
        conversationCount += await conversations.countDocuments(filter);
      } else {
        const result = await conversations.updateMany(filter, {
          $set: { inboxId: channel.inboxId, updatedAt: new Date() },
        });
        conversationCount += result.modifiedCount;
      }
    }

    console.log(
      `[${dryRun ? 'dry' : 'ok'}] tenant=${String(tenantId)} channels=${unbound.length} conversations=${conversationCount}`,
    );
  }
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exitCode = 1;
});
