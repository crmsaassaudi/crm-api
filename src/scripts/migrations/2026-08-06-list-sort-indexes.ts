/**
 * Creates the compound indexes that back list-view sorting.
 *
 * `autoIndex` is false in production (MongooseConfigService), so declaring an
 * index in a schema does NOT create it on a real cluster. Without this, the
 * sort controls added to the deal, ticket and account lists would resolve to an
 * in-memory sort — which does not merely run slowly, it fails outright past
 * Mongo's 32MB sort limit, and it fails for the biggest tenant first.
 *
 * Accounts are the notable case: the repository has accepted `sortBy=name`,
 * `annualRevenue`, `numberOfEmployees` and `updatedAt` since it was written and
 * none of the four had an index behind it. `sortable-fields.spec.ts` is what
 * surfaced that.
 *
 * Every index here must stay in step with `SORTABLE_FIELDS` — the spec asserts
 * that, so a field added to one without the other fails CI.
 *
 * Idempotent and additive: it never calls `syncIndexes`, which would drop
 * indexes another deployment still relies on. Builds are backgrounded so a
 * large collection stays writable.
 *
 * Run:
 *   npm run migrate:list-sort-indexes
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import type { Db } from 'mongodb';

interface PlannedIndex {
  collection: string;
  name: string;
  key: Record<string, 1 | -1>;
  why: string;
}

/**
 * One index per sortable field, each carrying the `_id` tie-breaker in the same
 * direction as the field.
 *
 * The tie-breaker is not decoration: sorting `{ closeDate: -1 }` alone over rows
 * that share a close date leaves their relative order undefined between two
 * queries, so a row can be served on page 1 and again on page 2 while another is
 * never served at all. Mongo walks an index backwards, so one descending index
 * serves both directions.
 */
export const PLANNED_SORT_INDEXES: PlannedIndex[] = [
  // ── deals ──────────────────────────────────────────────────────────────
  {
    collection: 'deals',
    name: 'tenant_updated_sort',
    key: { tenantId: 1, updatedAt: -1, _id: -1 },
    why: 'list sorted by last touched',
  },
  {
    collection: 'deals',
    name: 'tenant_value_sort',
    key: { tenantId: 1, value: -1, _id: -1 },
    why: '"biggest deals first" — the question a pipeline list exists to answer',
  },
  {
    collection: 'deals',
    name: 'tenant_close_date_sort',
    key: { tenantId: 1, closeDate: -1, _id: -1 },
    why: '"closing soonest"',
  },

  // ── tickets ────────────────────────────────────────────────────────────
  {
    collection: 'tickets',
    name: 'tenant_updated_sort',
    key: { tenantId: 1, updatedAt: -1, _id: -1 },
    why: 'queue sorted by last activity',
  },
  {
    collection: 'tickets',
    name: 'tenant_ticket_number_sort',
    key: { tenantId: 1, ticketNumber: -1, _id: -1 },
    why: 'sort by ticket number; the unique index on the same field lacks the _id tie-breaker and exists for the constraint',
  },

  // ── accounts ───────────────────────────────────────────────────────────
  {
    collection: 'accounts',
    name: 'tenant_updated_sort',
    key: { tenantId: 1, updatedAt: -1, _id: -1 },
    why: 'list sorted by last touched',
  },
  {
    collection: 'accounts',
    name: 'tenant_name_sort',
    key: { tenantId: 1, name: 1, _id: 1 },
    why: 'alphabetical — accepted by the API since it was written, never indexed',
  },
  {
    collection: 'accounts',
    name: 'tenant_annual_revenue_sort',
    key: { tenantId: 1, annualRevenue: -1, _id: -1 },
    why: 'largest customers first — accepted by the API since it was written, never indexed',
  },
  {
    collection: 'accounts',
    name: 'tenant_employees_sort',
    key: { tenantId: 1, numberOfEmployees: -1, _id: -1 },
    why: 'company size — accepted by the API since it was written, never indexed',
  },
];

/** Key equality including field ORDER — `{a,b}` and `{b,a}` are different indexes. */
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
}

/** One idempotent pass. `log` is injectable so tests stay quiet. */
export async function migrateListSortIndexes(
  db: Db,
  log: (message: string) => void = () => {},
): Promise<MigrationReport> {
  const report: MigrationReport = { created: [], dropped: [], skipped: [] };

  for (const planned of PLANNED_SORT_INDEXES) {
    const collection = db.collection(planned.collection);
    const label = `${planned.collection}.${planned.name}`;
    let existing = await collection.indexes();

    const byName = existing.find((index) => index.name === planned.name);
    if (byName) {
      if (sameKey(byName.key as Record<string, unknown>, planned.key)) {
        report.skipped.push(label);
        log(`[skip] ${label} already present`);
        continue;
      }
      // Same name, different key: createIndex refuses a conflicting
      // redefinition, so the old one goes first.
      await collection.dropIndex(planned.name);
      report.dropped.push(label);
      log(`[ok]   dropped ${label} (key changed)`);
      existing = await collection.indexes();
    }

    const duplicate = existing.find(
      (index) =>
        index.name !== planned.name &&
        sameKey(index.key as Record<string, unknown>, planned.key),
    );
    if (duplicate) {
      report.skipped.push(label);
      log(`[skip] ${label} — equivalent index already exists as ${duplicate.name}`);
      continue;
    }

    await collection.createIndex(planned.key, {
      name: planned.name,
      background: true,
    });
    report.created.push(label);
    log(`[ok]   created ${label} — ${planned.why}`);
  }

  return report;
}

async function main() {
  const uri = process.env.DATABASE_URL ?? process.env.MONGO_URL;
  if (!uri) throw new Error('DATABASE_URL or MONGO_URL is required');
  await mongoose.connect(uri, {
    dbName: process.env.DATABASE_NAME || undefined,
  });
  try {
    const db = mongoose.connection.db!;
    // Name the database out loud: a URI with no path lands on `test`, where the
    // migration "succeeds" against a database nobody uses. DATABASE_NAME being
    // ignored has bitten this repo before.
    console.log(`[db] ${db.databaseName}`);

    const report = await migrateListSortIndexes(db as unknown as Db, (line) =>
      console.log(line),
    );

    console.log(
      `[done] created=${report.created.length} dropped=${report.dropped.length} ` +
        `unchanged=${report.skipped.length}`,
    );
  } finally {
    await mongoose.disconnect();
  }
}

// Only run when invoked as a script, so importing it from a test does not connect.
if (require.main === module) {
  main().catch((error) => {
    console.error('[fail]', error);
    process.exitCode = 1;
  });
}
