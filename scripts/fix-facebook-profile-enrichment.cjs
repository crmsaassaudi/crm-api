/**
 * scripts/fix-facebook-profile-enrichment.cjs
 *
 * Bulk-enriches all Facebook conversations where customer.name is still
 * the raw PSID (numeric string) by calling the Graph API and updating MongoDB.
 *
 * Usage:
 *   node scripts/fix-facebook-profile-enrichment.cjs
 *
 * Required: Run from the crm-api project root so node_modules are available.
 */

const mongoose = require('mongoose');
const axios = require('axios');

// ---------------------------------------------------------------------------
// Config — update MONGO_URL if needed (or export it as an env var)
// ---------------------------------------------------------------------------
const MONGO_URL = process.env.MONGODB_URL || process.env.DATABASE_URL;
if (!MONGO_URL) {
  console.error('❌ MONGODB_URL env var is required. Usage: MONGODB_URL=mongodb+srv://... node scripts/fix-facebook-profile-enrichment.cjs');
  process.exit(1);
}

(async () => {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGO_URL);
  const db = mongoose.connection.db;
  console.log('Connected.\n');

  // ─── Step 1: Load channel credentials ─────────────────────────────────────
  const channels = await db.collection('channels').find({ type: 'Facebook' }).toArray();
  if (!channels.length) {
    console.error('No Facebook channels found. Exiting.');
    return await mongoose.disconnect();
  }

  // Build a map: pageId → accessToken (so we handle multiple pages)
  const tokenMap = {};
  for (const ch of channels) {
    const token = ch.credentials?.accessToken;
    if (ch.account && token) {
      tokenMap[ch.account] = token;
    }
  }
  console.log(`Found ${channels.length} Facebook channel(s):`, Object.keys(tokenMap));

  // ─── Step 2: Find un-enriched conversations ────────────────────────────────
  const convs = await db
    .collection('omni_conversations')
    .find({ channelType: 'Facebook' })
    .toArray();

  const toEnrich = convs.filter(
    (c) => c.customer && /^[0-9]+$/.test(c.customer.name || ''),
  );

  console.log(`\nConversations to enrich: ${toEnrich.length} / total: ${convs.length}\n`);

  if (!toEnrich.length) {
    console.log('Nothing to do. All profiles already enriched.');
    return await mongoose.disconnect();
  }

  // ─── Step 3: Enrich each unique PSID ──────────────────────────────────────
  const seen = new Set();
  let successCount = 0;
  let failCount = 0;

  for (const conv of toEnrich) {
    const psid = conv.customer?.externalId;
    const pageId = conv.channelAccount;

    if (!psid || seen.has(psid)) continue;
    seen.add(psid);

    const token = tokenMap[pageId];
    if (!token) {
      console.warn(`⚠  No token found for page ${pageId} — skipping PSID ${psid}`);
      failCount++;
      continue;
    }

    try {
      const res = await axios.get(`https://graph.facebook.com/v19.0/${psid}`, {
        params: {
          fields: 'name,first_name,last_name,picture{url}',
          access_token: token,
        },
        timeout: 8000,
      });

      const d = res.data;
      const name =
        d.name ||
        [d.first_name, d.last_name].filter(Boolean).join(' ') ||
        psid;
      const avatarUrl = d.picture?.data?.url || undefined;

      const result = await db.collection('omni_conversations').updateMany(
        { 'customer.externalId': psid, channelType: 'Facebook' },
        { $set: { 'customer.name': name, 'customer.avatarUrl': avatarUrl } },
      );

      console.log(
        `✓  PSID ${psid} → name: "${name}" | avatar: ${avatarUrl ? 'yes' : 'no'} | docs updated: ${result.modifiedCount}`,
      );
      successCount++;
    } catch (e) {
      const errData = JSON.stringify(e.response?.data || e.message);
      console.error(`✗  PSID ${psid} failed: ${errData}`);
      failCount++;
    }
  }

  // ─── Step 4: Summary ──────────────────────────────────────────────────────
  console.log(`\n─── Done ────────────────────────────────────`);
  console.log(`  Enriched: ${successCount}`);
  console.log(`  Failed:   ${failCount}`);
  console.log(`─────────────────────────────────────────────`);

  await mongoose.disconnect();
})();
