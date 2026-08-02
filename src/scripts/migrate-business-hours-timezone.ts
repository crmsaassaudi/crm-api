/**
 * Convert `business_hours.timezone` from abbreviations to IANA identifiers.
 *
 * The seeded default was `'ict'` and the settings picker offered `'ict'`,
 * `'utc'` and `'est'`. Only the last two happen to be zones Intl recognises;
 * `'ict'` is not one, so BusinessHoursService caught the rejection and quietly
 * used UTC. Every tenant that kept the default — which is every tenant that
 * never opened the screen — has been running its schedule seven hours from
 * where it says it is, which shows up as replies routed as "out of hours" in
 * the middle of the working day.
 *
 * The stored value is taken at face value: someone who chose ICT meant
 * Bangkok/Hanoi, so that is what they get. Anything already IANA is left alone.
 *
 *   npm run migrate:business-hours-timezone -- --dry-run
 *   npm run migrate:business-hours-timezone
 *
 * Idempotent: only the three legacy abbreviations are rewritten. Safe to rerun.
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const IANA_BY_ABBREVIATION: Record<string, string> = {
  ict: 'Asia/Ho_Chi_Minh',
  utc: 'UTC',
  est: 'America/New_York',
};

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
    const settings = client.db().collection('crm_settings');

    const rows = await settings
      .find(
        { key: 'business_hours' },
        { projection: { _id: 1, tenantId: 1, 'value.timezone': 1 } },
      )
      .toArray();

    console.log(
      `${rows.length} business_hours setting(s) found` +
        (dryRun ? ' — DRY RUN, nothing will be written.' : ''),
    );

    let migrated = 0;
    for (const row of rows) {
      const current = (row as any).value?.timezone;
      if (typeof current !== 'string') continue;

      const replacement = IANA_BY_ABBREVIATION[current.toLowerCase()];
      // Only the abbreviations move. A value that is already an identifier —
      // including one an admin typed by hand — is left exactly as it is.
      if (!replacement || replacement === current) continue;

      console.log(`  ${row.tenantId}: "${current}" → "${replacement}"`);
      if (!dryRun) {
        await settings.updateOne(
          { _id: row._id },
          { $set: { 'value.timezone': replacement } },
        );
      }
      migrated += 1;
    }

    console.log(
      `${migrated} setting(s) ${dryRun ? 'would be migrated' : 'migrated'}.`,
    );
  } finally {
    await client.close();
  }
}

void main();
