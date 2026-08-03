import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

/**
 * Report where `contact_identities` disagrees with the authoritative
 * `emails[]` / `phones[]` / `omniIdentities[]` arrays.
 *
 * Why drift is expected, and why that makes this necessary
 *
 * `ContactIdentitySyncService` is deliberately **non-throwing**: the arrays are the
 * source of truth and are already saved by the time it runs, so letting a projection
 * failure fail the contact write would be worse than letting the projection lag. That
 * is the right trade-off, and it means drift is a normal operating condition rather
 * than an impossible one.
 *
 * Which was the gap: nothing detected it. A missing identity row is not cosmetic —
 *
 *   - the partial unique index is not protecting that value, so a second contact can
 *     be created holding the same email;
 *   - the omni resolver's identity-row lookup cannot find that contact, so an inbound
 *     message may create a duplicate shadow contact for someone already known;
 *   - and per-identity state (verified, bounced, consent) has nowhere to live.
 *
 * Reporting rather than repairing is intentional: `backfill:contact-identities` is the
 * repair, and it already exists. Splitting detection from repair means this can be run
 * on a schedule and alerted on without any chance of it writing.
 *
 * Why this is the prerequisite for retiring the arrays
 *
 * The read path cannot move to `contact_identities` while the sync is best-effort:
 * `findDuplicateByIdentity` backs the uniqueness check, and an unsynced email would
 * slip past a check that read the collection instead of the arrays — strictly worse
 * than today. So the cutover is blocked on the sync being *trustworthy*, not on
 * migration sequencing. This is how you find out whether it is.
 *
 * Usage:
 *   npm run check:contact-identity-drift
 *   npm run check:contact-identity-drift -- --tenantId=6650... --countryCode=84
 *   npm run check:contact-identity-drift -- --max 0     # exit 1 on any drift (CI/cron)
 *
 * Read-only. Never writes.
 */

const BATCH_SIZE = 500;
const SAMPLE_LIMIT = 25;

interface Args {
  tenantId?: string;
  countryCode?: string;
  max?: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (key: string) => {
    const match = argv.find((a) => a.startsWith(`--${key}=`));
    if (match) return match.slice(key.length + 3);
    const idx = argv.indexOf(`--${key}`);
    return idx > -1 ? argv[idx + 1] : undefined;
  };
  const max = get('max');
  return {
    tenantId: get('tenantId'),
    countryCode: get('countryCode'),
    max: max !== undefined ? Number(max) : undefined,
  };
}

// Mirrors common/identity/identity-normalizer.ts. Duplicated because this runs on a
// raw MongoClient with no Nest container; identity-normalizer.spec.ts is the reference.
const normalizeEmail = (value: string) => value.trim().toLowerCase();

function normalizePhone(value: string, cc?: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  if (trimmed.startsWith('+')) return `+${digits}`;
  if (digits.startsWith('00') && digits.length > 4)
    return `+${digits.slice(2)}`;
  const code = (cc ?? '').replace(/\D/g, '');
  if (code) {
    if (digits.startsWith('0')) return `+${code}${digits.slice(1)}`;
    if (digits.startsWith(code)) return `+${digits}`;
    return `+${code}${digits}`;
  }
  return digits;
}

/** The identity keys a contact document implies, as `type:value`. */
function expectedKeys(contact: any, countryCode?: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of contact.emails ?? []) {
    if (typeof raw !== 'string') continue;
    const value = normalizeEmail(raw);
    if (value) keys.add(`email:${value}`);
  }
  for (const raw of contact.phones ?? []) {
    if (typeof raw !== 'string') continue;
    const value = normalizePhone(raw, countryCode);
    if (value) keys.add(`phone:${value}`);
  }
  for (const identity of contact.omniIdentities ?? []) {
    if (!identity?.channelType || !identity?.senderId) continue;
    keys.add(
      `omni:${String(identity.channelType).toLowerCase()}:${identity.senderId}`,
    );
  }
  return keys;
}

async function run(): Promise<void> {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const args = parseArgs();
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db();

    const filter: Record<string, unknown> = { deletedAt: null };
    if (args.tenantId) filter.tenantId = new ObjectId(args.tenantId);

    console.log(
      `Checking contact_identities drift${
        args.tenantId ? ` for tenant ${args.tenantId}` : ' across ALL tenants'
      }…`,
    );
    if (!args.countryCode) {
      console.log(
        'No --countryCode: national-format phones are compared as typed, which can\n' +
          'report drift that is really a normalisation difference. Pass the tenant\n' +
          'dialling code for an accurate phone comparison.',
      );
    }

    let scanned = 0;
    const missing: string[] = [];
    const orphaned: string[] = [];
    let missingCount = 0;
    let orphanedCount = 0;

    const cursor = db
      .collection('contacts')
      .find(filter, {
        projection: { emails: 1, phones: 1, omniIdentities: 1 },
      })
      .batchSize(BATCH_SIZE);

    for await (const contact of cursor) {
      scanned++;
      const expected = expectedKeys(contact, args.countryCode);

      const rows = await db
        .collection('contact_identities')
        .find(
          { contactId: contact._id, deletedAt: null },
          { projection: { type: 1, normalisedValue: 1 } },
        )
        .toArray();

      const actual = new Set(
        rows.map((row: any) =>
          row.type === 'omni'
            ? `omni:${row.normalisedValue}`
            : `${row.type}:${row.normalisedValue}`,
        ),
      );

      // In the arrays but not in the collection: the unique index is not protecting
      // this value and the resolver cannot find this contact by it.
      for (const key of expected) {
        if (!actual.has(key)) {
          missingCount++;
          if (missing.length < SAMPLE_LIMIT) {
            missing.push(`${String(contact._id)}  ${key}`);
          }
        }
      }

      // In the collection but not in the arrays: a row that survived a value being
      // removed, so it is still reserving that value against this contact.
      for (const key of actual) {
        if (!expected.has(key)) {
          orphanedCount++;
          if (orphaned.length < SAMPLE_LIMIT) {
            orphaned.push(`${String(contact._id)}  ${key}`);
          }
        }
      }
    }

    const total = missingCount + orphanedCount;

    console.log(
      `\n  contacts scanned      ${scanned}\n` +
        `  missing identity rows ${missingCount}\n` +
        `  orphaned rows         ${orphanedCount}`,
    );

    const report = (label: string, samples: string[], count: number) => {
      if (samples.length === 0) return;
      console.log(`\n${label}:`);
      for (const line of samples) console.log(`  ${line}`);
      if (count > samples.length) {
        console.log(`  … and ${count - samples.length} more`);
      }
    };

    report(
      'Missing (in the arrays, not in contact_identities)',
      missing,
      missingCount,
    );
    report(
      'Orphaned (in contact_identities, not in the arrays)',
      orphaned,
      orphanedCount,
    );

    if (total > 0) {
      console.log(
        '\nRepair with:\n' +
          '  npm run backfill:contact-identities -- --dry-run\n' +
          'then without --dry-run. It reconciles both directions and is idempotent.',
      );
    } else {
      console.log('\nNo drift. The projection matches the arrays exactly.');
    }

    if (args.max !== undefined && total > args.max) {
      console.error(`\nDrift (${total}) exceeds --max ${args.max}.`);
      process.exit(1);
    }
  } finally {
    await client.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
