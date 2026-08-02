/**
 * Restore the alias lock for tenants whose reservation the TTL index ate.
 *
 * `tenant_alias_reservations.expiresAt` carries a TTL index, and confirming a
 * reservation only flipped its status — it never cleared the expiry. So thirty
 * minutes after every successful signup Mongo deleted the row that was holding
 * the name. The alias then looked free to `reserve()` while the `tenants`
 * collection's unique index still held it, and the next person who asked for
 * it passed the availability check and died later on a duplicate key.
 *
 * `confirm()` now unsets `expiresAt`, which fixes it going forward. Every
 * tenant provisioned before that fix is missing its row, and this puts them
 * back as CONFIRMED with no expiry.
 *
 *   npm run migrate:alias-reservations -- --dry-run
 *   npm run migrate:alias-reservations
 *
 * Idempotent: an existing reservation is only touched if it still carries an
 * expiry or is not yet CONFIRMED. Safe to rerun; safe to interrupt.
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';

async function main(): Promise<void> {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const dryRun = process.argv.includes('--dry-run');
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db();
    const tenants = db.collection('tenants');
    const reservations = db.collection('tenant_alias_reservations');

    const rows = await tenants
      .find(
        { alias: { $exists: true, $ne: null } },
        { projection: { alias: 1 } },
      )
      .toArray();

    console.log(
      `${rows.length} tenant alias(es) to check` +
        (dryRun ? ' — DRY RUN, nothing will be written.' : ''),
    );

    let restored = 0;
    let repaired = 0;

    for (const tenant of rows) {
      const alias = tenant.alias as string;
      const existing = await reservations.findOne({ alias });

      if (existing?.status === 'CONFIRMED' && existing.expiresAt == null) {
        continue;
      }

      if (!dryRun) {
        await reservations.updateOne(
          { alias },
          {
            $set: { status: 'CONFIRMED' },
            $unset: { expiresAt: '' },
            $setOnInsert: { alias, createdAt: new Date() },
          },
          { upsert: true },
        );
      }

      if (existing) {
        repaired += 1;
      } else {
        restored += 1;
      }
    }

    console.log(
      `${restored} reservation(s) ${dryRun ? 'would be ' : ''}recreated, ` +
        `${repaired} ${dryRun ? 'would have ' : ''}had the expiry cleared.`,
    );
  } finally {
    await client.close();
  }
}

void main();
