/**
 * Contact B2C readiness — indexes and the customer-value backfill.
 *
 * `autoIndex` is false in production, so an index declared in a schema does NOT
 * exist on a real cluster until something creates it. Everything added by this
 * change set is created here, and the two indexes it supersedes are dropped.
 *
 * It also backfills `totalRevenue` / `dealsCount` / `wonDealsCount` /
 * `firstPurchaseAt` / `lastPurchaseAt` from existing won deals. Without this
 * pass every contact reads as a customer worth nothing until its next deal
 * write — and a value segment built on that would exclude the tenant's best
 * customers, silently.
 *
 * Idempotent and additive: it never calls `syncIndexes`, and re-running it
 * recomputes the same values from the same deals.
 *
 * Run:
 *   npm run migrate:contact-b2c-readiness -- --dry-run
 *   npm run migrate:contact-b2c-readiness
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import type { Db } from 'mongodb';

interface PlannedIndex {
  collection: string;
  name: string;
  key: Record<string, 1 | -1>;
  options?: Record<string, unknown>;
  why: string;
}

/** Must stay in step with the index blocks in contact.schema / deal.schema. */
export const PLANNED_INDEXES: PlannedIndex[] = [
  {
    collection: 'contacts',
    name: 'tenant_external_identity',
    key: { tenantId: 1, externalSource: 1, externalId: 1 },
    options: {
      unique: true,
      partialFilterExpression: {
        externalId: { $type: 'string' },
        externalSource: { $type: 'string' },
      },
    },
    why: 'idempotency key for external sync; partial so UI-created rows do not collide on (null,null)',
  },
  {
    collection: 'contacts',
    name: 'tenant_active_totalRevenue_cursor',
    key: { tenantId: 1, totalRevenue: -1, _id: -1 },
    options: { partialFilterExpression: { deletedAt: null } },
    why: 'sort and segment by customer value',
  },
  {
    collection: 'contacts',
    name: 'tenant_active_lastPurchaseAt_cursor',
    key: { tenantId: 1, lastPurchaseAt: -1, _id: -1 },
    options: { partialFilterExpression: { deletedAt: null } },
    why: '"bought once, never again" — the core B2C win-back segment',
  },
  {
    collection: 'contacts',
    name: 'tenant_active_lastActivityAt_cursor',
    key: { tenantId: 1, lastActivityAt: -1, _id: -1 },
    options: { partialFilterExpression: { deletedAt: null } },
    why: 'dormancy filters (`in_last_days`); replaces tenant_last_activity',
  },
  {
    collection: 'contacts',
    name: 'tenant_geo_lookup',
    key: { tenantId: 1, country: 1, city: 1 },
    why: 'geography axis of every B2C segment',
  },
  {
    collection: 'contact_segments',
    name: 'tenant_segment_name',
    key: { tenantId: 1, name: 1 },
    options: { unique: true },
    why: 'two segments called "VIP" is how the wrong audience gets picked',
  },
  {
    collection: 'contact_segments',
    name: 'tenant_segment_list',
    key: { tenantId: 1, updatedAt: -1 },
    why: 'segment picker, newest first',
  },
  {
    collection: 'deals',
    name: 'tenant_contact_deals',
    key: { tenantId: 1, contactIds: 1, wonAt: -1 },
    why: "this person's deals — timeline source and value rollup",
  },
];

/** Indexes to remove, with the reason recorded so nobody recreates them. */
const OBSOLETE: Array<{ collection: string; name: string; why: string }> = [
  {
    collection: 'contacts',
    name: 'tenant_last_activity',
    why: 'superseded by the partial tenant_active_lastActivityAt_cursor, which excludes deleted rows and carries the _id tie-breaker',
  },
  {
    collection: 'deals',
    name: 'contactIds_1',
    why: 'bare multikey index with no tenant prefix; no query omits tenantId, and a cross-tenant array index is one of the largest on the collection',
  },
];

function sameKey(a: Record<string, unknown>, b: Record<string, unknown>) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return (
    ak.length === bk.length &&
    ak.every((key, index) => bk[index] === key && a[key] === b[key])
  );
}

export interface MigrationReport {
  created: string[];
  dropped: string[];
  skipped: string[];
  contactsValued: number;
}

export async function migrateContactB2cReadiness(
  db: Db,
  options: { dryRun?: boolean } = {},
  log: (message: string) => void = () => {},
): Promise<MigrationReport> {
  const report: MigrationReport = {
    created: [],
    dropped: [],
    skipped: [],
    contactsValued: 0,
  };

  for (const obsolete of OBSOLETE) {
    const collection = db.collection(obsolete.collection);
    const existing = await collection.indexes();
    if (!existing.some((index) => index.name === obsolete.name)) continue;
    if (options.dryRun) {
      log(`[dry]  would drop ${obsolete.collection}.${obsolete.name}`);
      continue;
    }
    await collection.dropIndex(obsolete.name);
    report.dropped.push(`${obsolete.collection}.${obsolete.name}`);
    log(`[ok]   dropped ${obsolete.name} — ${obsolete.why}`);
  }

  for (const planned of PLANNED_INDEXES) {
    const collection = db.collection(planned.collection);
    let existing = await collection.indexes();
    const label = `${planned.collection}.${planned.name}`;

    const byName = existing.find((index) => index.name === planned.name);
    if (byName) {
      if (sameKey(byName.key as any, planned.key)) {
        report.skipped.push(label);
        log(`[skip] ${label} already present`);
        continue;
      }
      // Same name, different key: createIndex refuses a conflicting
      // redefinition, so the old one has to go first.
      if (options.dryRun) {
        log(`[dry]  would rebuild ${label} (key changed)`);
        continue;
      }
      await collection.dropIndex(planned.name);
      report.dropped.push(label);
      existing = await collection.indexes();
    }

    if (options.dryRun) {
      log(`[dry]  would create ${label}`);
      continue;
    }
    await collection.createIndex(planned.key, {
      name: planned.name,
      background: true,
      ...(planned.options ?? {}),
    });
    report.created.push(label);
    log(`[ok]   created ${label} — ${planned.why}`);
  }

  report.contactsValued = await backfillContactValue(db, options, log);
  return report;
}

/**
 * Recompute customer value from won deals, for every contact that has one.
 *
 * Driven from `deals`, not from `contacts`: only contacts with deals have a
 * value to compute, and that is a small fraction of a B2C database. Walking the
 * contacts collection instead would be one aggregation per contact for a result
 * that is zero almost every time — the schema default already says zero.
 */
async function backfillContactValue(
  db: Db,
  options: { dryRun?: boolean },
  log: (message: string) => void,
): Promise<number> {
  const rows = db.collection('deals').aggregate(
    [
      { $match: { deletedAt: null, contactIds: { $ne: [] } } },
      { $unwind: '$contactIds' },
      {
        $group: {
          _id: { tenantId: '$tenantId', contactId: '$contactIds' },
          dealsCount: { $sum: 1 },
          wonDealsCount: {
            $sum: { $cond: [{ $ifNull: ['$wonAt', false] }, 1, 0] },
          },
          totalRevenue: {
            $sum: {
              $cond: [
                { $ifNull: ['$wonAt', false] },
                { $ifNull: ['$value', 0] },
                0,
              ],
            },
          },
          firstPurchaseAt: { $min: '$wonAt' },
          lastPurchaseAt: { $max: '$wonAt' },
        },
      },
    ],
    { allowDiskUse: true },
  );

  let processed = 0;
  let batch: any[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    if (!options.dryRun) {
      await db.collection('contacts').bulkWrite(batch, { ordered: false });
    }
    processed += batch.length;
    batch = [];
    log(`[ok]   valued ${processed} contacts`);
  };

  for await (const row of rows) {
    batch.push({
      updateOne: {
        filter: { _id: row._id.contactId, tenantId: row._id.tenantId },
        update: {
          $set: {
            dealsCount: row.dealsCount,
            wonDealsCount: row.wonDealsCount,
            totalRevenue: row.totalRevenue,
            firstPurchaseAt: row.firstPurchaseAt ?? null,
            lastPurchaseAt: row.lastPurchaseAt ?? null,
          },
        },
      },
    });
    if (batch.length >= 1_000) await flush();
  }
  await flush();

  return processed;
}

async function main() {
  const uri = process.env.DATABASE_URL ?? process.env.MONGO_URL;
  if (!uri) throw new Error('DATABASE_URL or MONGO_URL is required');
  const dryRun = process.argv.includes('--dry-run');

  await mongoose.connect(uri, {
    dbName: process.env.DATABASE_NAME || undefined,
  });
  try {
    const db = mongoose.connection.db!;
    // Name the database out loud: a URI with no path lands on `test`, where the
    // migration "succeeds" against a database nobody uses.
    console.log(
      `[db] ${db.databaseName} — ${await db
        .collection('contacts')
        .estimatedDocumentCount()} contacts${dryRun ? ' (dry run)' : ''}`,
    );
    // Mongoose bundles its own `mongodb` copy; the two `Db` types are
    // structurally identical but nominally distinct.
    const report = await migrateContactB2cReadiness(
      db as unknown as Db,
      { dryRun },
      (line) => console.log(line),
    );
    console.log(
      `[done] created=${report.created.length} dropped=${report.dropped.length} ` +
        `skipped=${report.skipped.length} valued=${report.contactsValued}`,
    );
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
