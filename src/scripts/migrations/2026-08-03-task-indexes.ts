/**
 * Creates the `tasks` indexes and drops the dead ones.
 *
 * Required because `autoIndex` is false in production (MongooseConfigService), so
 * declaring an index in the schema does NOT create it there. Nothing had ever
 * created the task indexes through a migration, and `tasks` was absent from
 * `verify-operational-indexes`, so which indexes existed on a production cluster
 * was simply unknown — the schema was not evidence either way.
 *
 * Also drops `tenantId_1_status_1`. That index keyed a field the schema does not
 * define (the field is `statusId`), so it stored a null entry for every document:
 * it cost writes and served no read.
 *
 * Everything below is idempotent and additive; it never calls `syncIndexes`,
 * which would drop indexes another deployment is still relying on. Index builds
 * are backgrounded so a large collection stays writable.
 *
 * The migration itself lives in `migrateTaskIndexes`, exported so
 * `tasks.index-migration.integration.spec.ts` can run THIS code against a real
 * server rather than a re-implementation of it — a migration verified by a copy of
 * its own logic is not verified.
 *
 * Run:
 *   npm run migrate:task-indexes
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import type { Db } from 'mongodb';

const COLLECTION = 'tasks';

interface PlannedIndex {
  name: string;
  key: Record<string, 1 | -1>;
  options?: { sparse?: boolean };
  why: string;
}

/** Must stay in step with the index block in `task.schema.ts`. */
export const PLANNED_TASK_INDEXES: PlannedIndex[] = [
  {
    name: 'task_list_default',
    key: { tenantId: 1, deletedAt: 1, dueDate: 1, _id: 1 },
    why: 'default list view; _id included so the sort needs no in-memory pass',
  },
  {
    name: 'task_list_created',
    key: { tenantId: 1, deletedAt: 1, createdAt: -1, _id: -1 },
    why: 'list sorted by recency; sortBy only offers index-backed fields',
  },
  {
    name: 'task_owner_due',
    key: { tenantId: 1, ownerId: 1, deletedAt: 1, dueDate: 1 },
    why: '"my tasks"',
  },
  {
    name: 'task_status_due',
    key: { tenantId: 1, statusId: 1, deletedAt: 1, dueDate: 1 },
    why: 'kanban column queries',
  },
  {
    name: 'task_related_lookup',
    key: { tenantId: 1, 'relatedTo._id': 1 },
    why: 'tasks of one contact/deal/ticket — highest-frequency query, previously unindexed',
  },
  {
    name: 'task_org_unit_scope',
    key: { tenantId: 1, orgUnitId: 1, deletedAt: 1 },
    why: 'org-unit data scope',
  },
  {
    name: 'task_purge_sweep',
    key: { deletedAt: 1 },
    options: { sparse: true },
    why: 'retention purge; cross-tenant so tenantId is deliberately absent',
  },
  {
    name: 'recurring_tasks_cron',
    key: { isRecurring: 1, nextOccurrenceAt: 1, deletedAt: 1 },
    options: { sparse: true },
    why: 'recurrence scheduler sweep',
  },
  {
    name: 'task_reminder_due',
    key: { reminderSentAt: 1, reminderAt: 1, deletedAt: 1 },
    why: 'reminder dispatcher sweep',
  },
];

/** Indexes to remove, with the reason recorded so nobody recreates them. */
const OBSOLETE: Array<{
  match: (key: Record<string, unknown>) => boolean;
  why: string;
}> = [
  {
    match: (key) =>
      Object.keys(key).length === 2 && key.tenantId === 1 && key.status === 1,
    why: 'keys a field that does not exist on the schema (it is `statusId`)',
  },
  {
    match: (key) => Object.keys(key).length === 1 && key.orgUnitId === 1,
    why: 'standalone orgUnitId; superseded by task_org_unit_scope, which leads with tenantId as every scoped query does',
  },
];

/**
 * Key equality including field ORDER, which matters: `{a:1, b:1}` and `{b:1, a:1}`
 * are different indexes and serve different queries.
 */
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
export async function migrateTaskIndexes(
  db: Db,
  log: (message: string) => void = () => {},
): Promise<MigrationReport> {
  const collection = db.collection(COLLECTION);
  const report: MigrationReport = { created: [], dropped: [], skipped: [] };

  let existing = await collection.indexes();

  for (const obsolete of OBSOLETE) {
    const found = existing.find(
      (index) => index.name !== '_id_' && obsolete.match(index.key as any),
    );
    if (found?.name) {
      await collection.dropIndex(found.name);
      report.dropped.push(found.name);
      log(`[ok]   dropped ${found.name} — ${obsolete.why}`);
      existing = await collection.indexes();
    }
  }

  for (const planned of PLANNED_TASK_INDEXES) {
    const byName = existing.find((index) => index.name === planned.name);
    if (byName) {
      if (sameKey(byName.key as any, planned.key)) {
        report.skipped.push(planned.name);
        log(`[skip] ${planned.name} already present`);
        continue;
      }
      // Same name, different key: the definition changed. Drop and rebuild,
      // because createIndex refuses a conflicting redefinition.
      await collection.dropIndex(planned.name);
      report.dropped.push(planned.name);
      log(`[ok]   dropped ${planned.name} (key changed)`);
      existing = await collection.indexes();
    }

    const duplicate = existing.find(
      (index) =>
        index.name !== planned.name && sameKey(index.key as any, planned.key),
    );
    if (duplicate) {
      report.skipped.push(planned.name);
      log(
        `[skip] ${planned.name} — an equivalent index already exists as ${duplicate.name}`,
      );
      continue;
    }

    await collection.createIndex(planned.key, {
      name: planned.name,
      background: true,
      ...(planned.options ?? {}),
    });
    report.created.push(planned.name);
    log(`[ok]   created ${planned.name} — ${planned.why}`);
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
    // Name the database and the row count out loud: a URI with no path lands on
    // `test`, where every count is zero and the migration "succeeds" against a
    // database nobody uses. DATABASE_NAME being ignored has bitten this repo
    // before.
    console.log(
      `[db] ${db.databaseName} — ${await db
        .collection(COLLECTION)
        .countDocuments()} task(s)`,
    );

    const report = await migrateTaskIndexes(db as unknown as Db, (line) =>
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
