import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

/**
 * Populate `contact_identities` from the authoritative
 * `emails[]` / `phones[]` / `omniIdentities[]` arrays.
 *
 * The collection is written forward by `ContactIdentitySyncService` on every contact
 * create and identity-changing update, so it only needs seeding once per environment
 * plus a re-run if the mirror ever drifts (the sync is deliberately non-throwing, so
 * drift is possible by design — a projection that can fail a contact write would be
 * worse).
 *
 * ── Read this before running ──
 *
 * The unique index `(tenantId, type, normalisedValue)` is the point of the collection:
 * it turns the app-level `assertIdentityIsUnique` read-then-write into a real
 * constraint. Existing data may violate it — that is exactly the duplicate-contact
 * problem the audit found, sitting in the database unenforced.
 *
 * So this script **reports collisions rather than resolving them.** Two contacts
 * sharing an address is a merge decision, not something a migration should silently
 * pick a winner for. Run with `--dry-run` first, review the report, merge the genuine
 * duplicates through the merge UI (which re-parents everything and is reversible), then
 * run for real.
 *
 * With `--skip-conflicts` the first contact to claim a value keeps it and later ones
 * are listed and skipped, so the collection can be seeded before every duplicate has
 * been triaged. The skipped contacts keep working — the arrays remain authoritative.
 *
 * Usage:
 *   npm run backfill:contact-identities -- --dry-run
 *   npm run backfill:contact-identities -- --tenantId=6650... --countryCode=84
 *   npm run backfill:contact-identities -- --skip-conflicts
 *
 * Idempotent: rows are upserted on the unique key. Safe to rerun and to interrupt.
 */

const BATCH_SIZE = 500;

interface Args {
  dryRun: boolean;
  tenantId?: string;
  countryCode?: string;
  skipConflicts: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (key: string) => {
    const match = argv.find((a) => a.startsWith(`--${key}=`));
    return match ? match.slice(key.length + 3) : undefined;
  };
  return {
    dryRun: argv.includes('--dry-run'),
    tenantId: get('tenantId'),
    countryCode: get('countryCode'),
    skipConflicts: argv.includes('--skip-conflicts'),
  };
}

// Duplicated from common/identity/identity-normalizer.ts on purpose: this runs on a
// raw MongoClient with no Nest container. identity-normalizer.spec.ts is the reference
// behaviour — keep the two in step.
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

interface Derived {
  type: 'email' | 'phone' | 'omni';
  normalisedValue: string;
  rawValue: string;
  channelType?: string;
}

function derive(contact: any, countryCode?: string): Derived[] {
  const out: Derived[] = [];
  const seen = new Set<string>();
  const push = (d: Derived) => {
    const key = `${d.type}:${d.normalisedValue}`;
    if (!d.normalisedValue || seen.has(key)) return;
    seen.add(key);
    out.push(d);
  };

  for (const raw of contact.emails ?? []) {
    if (typeof raw !== 'string') continue;
    push({
      type: 'email',
      normalisedValue: normalizeEmail(raw),
      rawValue: raw,
    });
  }
  for (const raw of contact.phones ?? []) {
    if (typeof raw !== 'string') continue;
    push({
      type: 'phone',
      normalisedValue: normalizePhone(raw, countryCode),
      rawValue: raw,
    });
  }
  for (const identity of contact.omniIdentities ?? []) {
    if (!identity?.channelType || !identity?.senderId) continue;
    const channelType = String(identity.channelType).toLowerCase();
    push({
      type: 'omni',
      normalisedValue: `${channelType}:${identity.senderId}`,
      rawValue: String(identity.senderId),
      channelType,
    });
  }
  return out;
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
    const contacts = db.collection('contacts');
    const identities = db.collection('contact_identities');

    const filter: Record<string, unknown> = { deletedAt: null };
    if (args.tenantId) filter.tenantId = new ObjectId(args.tenantId);

    console.log(
      `Seeding contact_identities${args.tenantId ? ` for tenant ${args.tenantId}` : ' for ALL tenants'}`,
    );
    if (args.dryRun) console.log('DRY RUN — nothing will be written.');
    if (!args.countryCode) {
      console.log(
        'No --countryCode: national-format phones stay as typed, so they will not\n' +
          'match their E.164 twins. Pass the tenant dialling code to normalise them.',
      );
    }

    // `claimed` mirrors the unique index in memory so collisions are detected and
    // reported in one pass, instead of surfacing as an opaque E11000 per row.
    const claimed = new Map<string, string>();
    const collisions: string[] = [];
    let scanned = 0;
    let written = 0;
    let ops: any[] = [];

    const flush = async () => {
      if (ops.length === 0) return;
      if (!args.dryRun) {
        await identities.bulkWrite(ops, { ordered: false });
      }
      written += ops.length;
      ops = [];
    };

    const cursor = contacts
      .find(filter, {
        projection: {
          tenantId: 1,
          emails: 1,
          phones: 1,
          omniIdentities: 1,
          createdById: 1,
        },
      })
      .batchSize(BATCH_SIZE);

    for await (const contact of cursor) {
      scanned++;
      for (const identity of derive(contact, args.countryCode)) {
        const key = `${String(contact.tenantId)}|${identity.type}|${identity.normalisedValue}`;
        const holder = claimed.get(key);

        if (holder && holder !== String(contact._id)) {
          collisions.push(
            `${identity.type} ${identity.normalisedValue}: contact ${String(contact._id)} ` +
              `collides with ${holder}`,
          );
          if (args.skipConflicts) continue;
          // Without --skip-conflicts the run stops: writing "whichever came first
          // wins" without the operator having chosen that is not a migration's call.
          console.error(
            `\nCollision on ${identity.type} ${identity.normalisedValue} between ` +
              `contacts ${holder} and ${String(contact._id)}.\n` +
              'These are duplicate contacts. Merge them through the UI (the merge\n' +
              're-parents every related record and is reversible), or rerun with\n' +
              '--skip-conflicts to seed the rest and triage later.',
          );
          process.exit(1);
        }
        claimed.set(key, String(contact._id));

        ops.push({
          updateOne: {
            filter: {
              tenantId: contact.tenantId,
              type: identity.type,
              normalisedValue: identity.normalisedValue,
            },
            update: {
              $set: {
                contactId: contact._id,
                rawValue: identity.rawValue,
                ...(identity.channelType
                  ? { channelType: identity.channelType }
                  : {}),
                deletedAt: null,
              },
              $setOnInsert: {
                isPrimary: false,
                verified: false,
                optIn: null,
                source: 'backfill',
                createdById: contact.createdById ?? null,
                createdAt: new Date(),
              },
            },
            upsert: true,
          },
        });

        if (ops.length >= BATCH_SIZE) await flush();
      }
    }
    await flush();

    console.log(
      `\n  scanned      ${scanned} contact(s)\n` +
        `  identities   ${written} ${args.dryRun ? 'would be written' : 'written'}\n` +
        `  collisions   ${collisions.length}`,
    );

    if (collisions.length > 0) {
      console.log('\nCollisions (duplicate contacts sharing an identity):');
      for (const line of collisions.slice(0, 50)) console.log(`  ${line}`);
      if (collisions.length > 50) {
        console.log(`  … and ${collisions.length - 50} more`);
      }
      console.log(
        '\nEach of these is two contacts for one person. Merging them is the fix;\n' +
          'the merge re-parents every related record and can be undone.',
      );
    }

    if (!args.dryRun) {
      console.log(
        '\nDone. The arrays remain authoritative for reads — this collection adds the\n' +
          'unique constraint, per-identity verified/bounced state, and per-identity\n' +
          'consent. Nothing about existing behaviour changes.',
      );
    }
  } finally {
    await client.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
