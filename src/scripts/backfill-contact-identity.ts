import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

/**
 * Repair pass for the Contact domain: ownership and identity normalisation.
 *
 * Two independent defects left bad data behind. Both are fixed forward in the
 * code; this script cleans up the rows written before the fix.
 *
 * 1. UNOWNED IMPORTED CONTACTS
 *    The import worker writes through `bulkWrite`, which bypasses
 *    `BaseDocumentRepository.enrichWithContext` — the only place that stamps
 *    `ownerId`. Every contact created by an import therefore has no owner, and
 *    unowned records are deliberately hidden from scoped users (the C3 fix in
 *    document-repository.abstract.ts). Symptom: a 50k-row import lands in the
 *    database and is visible only to admins.
 *    Repair: set `ownerId` to `createdById` — the user who ran the import.
 *
 * 2. UN-NORMALISED EMAILS AND PHONES
 *    The REST path stored whatever the client sent while the import worker
 *    lower-cased emails and stripped phone separators. `findByEmail()`
 *    lower-cases its probe, so a contact created in the UI as `John@Acme.com`
 *    was invisible to the omni resolver, which then created a SECOND contact for
 *    the same person. Repair: normalise in place using the same functions the
 *    application now uses at the edge.
 *
 * The phone rewrite is the only lossy step, so it is opt-in per tenant via
 * --countryCode: without it, national-format numbers are left alone rather than
 * guessed at. `+`-prefixed numbers are always safe to compact.
 *
 * Usage:
 *   npm run backfill:contact-identity -- --dry-run
 *   npm run backfill:contact-identity -- --tenantId=6650... --countryCode=84
 *   npm run backfill:contact-identity -- --skip-ownership
 *   npm run backfill:contact-identity -- --skip-identity
 *
 * Idempotent: normalising an already-normalised value is a no-op, and only
 * contacts with a null/missing `ownerId` are given one. Safe to rerun; safe to
 * interrupt — progress is per-batch, not per-run.
 *
 * NOTE: run this BEFORE creating the unique identity indexes, so genuine
 * duplicates surface as index-build failures you can triage rather than as
 * silent mismatches.
 */

const BATCH_SIZE = 1000;

interface Args {
  dryRun: boolean;
  tenantId?: string;
  countryCode?: string;
  skipOwnership: boolean;
  skipIdentity: boolean;
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
    skipOwnership: argv.includes('--skip-ownership'),
    skipIdentity: argv.includes('--skip-identity'),
  };
}

// Duplicated from common/identity/identity-normalizer.ts on purpose: this
// script runs against a raw MongoClient with no Nest container, and importing
// application code would drag the DI graph in. Keep the two in sync — the spec
// in identity-normalizer.spec.ts is the reference behaviour.
function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

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

function normalizeList(
  values: unknown,
  fn: (v: string) => string,
): string[] | null {
  if (!Array.isArray(values)) return null;
  const next = Array.from(
    new Set(
      values
        .filter((v): v is string => typeof v === 'string')
        .map(fn)
        .filter((v) => v.length > 0),
    ),
  );
  const before = values.filter((v): v is string => typeof v === 'string');
  const unchanged =
    next.length === before.length && next.every((v, i) => v === before[i]);
  return unchanged ? null : next;
}

async function backfillOwnership(
  db: ReturnType<MongoClient['db']>,
  args: Args,
): Promise<number> {
  const filter: Record<string, unknown> = {
    ownerId: { $in: [null] },
    createdById: { $ne: null },
  };
  if (args.tenantId) filter.tenantId = new ObjectId(args.tenantId);

  if (args.dryRun) {
    return db.collection('contacts').countDocuments(filter);
  }

  // One bulk op per creator rather than one per contact: an import of 50k rows
  // by a single user costs one write.
  const creators = await db
    .collection('contacts')
    .distinct('createdById', filter);

  let total = 0;
  for (const createdById of creators) {
    if (!createdById) continue;
    const result = await db
      .collection('contacts')
      .updateMany({ ...filter, createdById }, [
        { $set: { ownerId: '$createdById' } },
      ]);
    total += result.modifiedCount;
  }
  return total;
}

async function backfillIdentity(
  db: ReturnType<MongoClient['db']>,
  args: Args,
): Promise<{ scanned: number; changed: number }> {
  const filter: Record<string, unknown> = {
    $or: [{ emails: { $ne: [] } }, { phones: { $ne: [] } }],
  };
  if (args.tenantId) filter.tenantId = new ObjectId(args.tenantId);

  const cursor = db
    .collection('contacts')
    .find(filter, { projection: { emails: 1, phones: 1 } })
    .batchSize(BATCH_SIZE);

  let scanned = 0;
  let changed = 0;
  let ops: any[] = [];

  const flush = async () => {
    if (ops.length === 0) return;
    if (!args.dryRun) {
      await db.collection('contacts').bulkWrite(ops, { ordered: false });
    }
    changed += ops.length;
    ops = [];
  };

  for await (const doc of cursor) {
    scanned++;
    const set: Record<string, unknown> = {};

    const emails = normalizeList(doc.emails, normalizeEmail);
    if (emails) set.emails = emails;

    const phones = normalizeList(doc.phones, (v) =>
      normalizePhone(v, args.countryCode),
    );
    if (phones) set.phones = phones;

    if (Object.keys(set).length > 0) {
      ops.push({
        updateOne: { filter: { _id: doc._id }, update: { $set: set } },
      });
    }
    if (ops.length >= BATCH_SIZE) await flush();
  }
  await flush();

  return { scanned, changed };
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

    console.log(
      `Contact identity repair${args.tenantId ? ` — tenant ${args.tenantId}` : ' — ALL tenants'}`,
    );
    if (args.dryRun) console.log('DRY RUN — counting only, nothing written.');
    if (!args.countryCode && !args.skipIdentity) {
      console.log(
        'No --countryCode: national-format phones will be left as-is.\n' +
          'Pass the tenant dialling code (e.g. --countryCode=84) to promote them to E.164.',
      );
    }

    if (!args.skipOwnership) {
      const owned = await backfillOwnership(db, args);
      console.log(
        `  ownership   ${owned} contact(s) ${args.dryRun ? 'would get' : 'given'} ownerId := createdById`,
      );
    }

    if (!args.skipIdentity) {
      const { scanned, changed } = await backfillIdentity(db, args);
      console.log(
        `  identity    ${changed} of ${scanned} scanned contact(s) ${args.dryRun ? 'would be' : ''} normalised`,
      );
    }

    if (!args.dryRun) {
      console.log(
        '\nDone. Next: create the unique identity indexes and triage any\n' +
          'duplicate-key failures — those are real duplicate people that the\n' +
          'un-normalised data was hiding.',
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
