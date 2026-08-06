/**
 * Ticket service-desk remediation — brings stored data in line with the
 * schema changes that turned the ticket module into a support desk.
 *
 *   1. Classify every `ticket_statuses` row with `terminalKind` / `pausesSla`,
 *      and clear the `closedAt` a Resolved ticket was stamped with.
 *   2. Backfill `ownerAssignedExplicitly`, the flag the routing engine reads.
 *   3. Stamp `sla_policies.appliesTo`, rename `omni_sla_clocks` → `sla_clocks`,
 *      rekey it onto `(subjectType, subjectId)` and rebuild its indexes.
 *   4. Initialise `reopenCount`, the denominator of Reopen Rate.
 *
 * Must run BEFORE the new API rolls out: step 3 renames the collection the
 * clock engine reads.
 *
 * Idempotent — every step is a conditional update or a guarded rename.
 *
 * Run:
 *   npm run migrate:ticket-service-desk -- --dry-run
 *   npm run migrate:ticket-service-desk
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import type { Db } from 'mongodb';

/**
 * How a seeded status `apiName` maps onto the new terminal classification.
 *
 * Anything not listed keeps `terminalKind: null`. A tenant that renamed its
 * statuses gets the safe answer — non-terminal — and fixes it in Settings,
 * which is preferable to guessing and silently closing live cases.
 */
const TERMINAL_BY_API_NAME: Record<string, 'resolved' | 'closed'> = {
  resolved: 'resolved',
  closed: 'closed',
  cancelled: 'closed',
  canceled: 'closed',
};

/** Statuses whose meaning is "waiting on someone else" — the SLA pauses there. */
const PAUSING_API_NAMES = new Set([
  'on_hold',
  'pending',
  'waiting_customer',
  'waiting_on_customer',
]);

export interface MigrationReport {
  statusesClassified: number;
  statusesPausing: number;
  closedStampsCleared: number;
  ownerIntentBackfilled: number;
  reopenCountsInitialised: number;
  policiesStamped: number;
  clocksMigrated: number;
  clockCollectionRenamed: boolean;
  clockIndexesRebuilt: boolean;
  skipped: string[];
}

export async function migrateTicketServiceDesk(
  db: Db,
  options: { dryRun?: boolean } = {},
  log: (message: string) => void = () => {},
): Promise<MigrationReport> {
  const report: MigrationReport = {
    statusesClassified: 0,
    statusesPausing: 0,
    closedStampsCleared: 0,
    ownerIntentBackfilled: 0,
    reopenCountsInitialised: 0,
    policiesStamped: 0,
    clocksMigrated: 0,
    clockCollectionRenamed: false,
    clockIndexesRebuilt: false,
    skipped: [],
  };

  await classifyStatuses(db, options, log, report);
  await clearFabricatedCloseStamps(db, options, log, report);
  await backfillOwnerIntent(db, options, log, report);
  await initialiseReopenCount(db, options, log, report);
  await stampSlaPolicies(db, options, log, report);
  await migrateSlaClocks(db, options, log, report);

  return report;
}

/**
 * Give every existing status a `terminalKind` and a `pausesSla` flag.
 *
 * `isTerminal` is left as it is: the transition guard still asks only "is this
 * an end state", and rewriting it from a guess would change which transitions
 * are refused.
 */
async function classifyStatuses(
  db: Db,
  options: { dryRun?: boolean },
  log: (message: string) => void,
  report: MigrationReport,
): Promise<void> {
  const statuses = db.collection('ticket_statuses');
  const pending = await statuses
    .find({ terminalKind: { $exists: false } })
    .project({ _id: 1, apiName: 1, isTerminal: 1 })
    .toArray();

  for (const status of pending) {
    const apiName = String(status.apiName ?? '').toLowerCase();
    // An `isTerminal` status whose name we do not recognise is classified
    // `closed`: it already ends the case, and calling it `resolved` would make
    // it stop the clock without ever closing the ticket.
    const terminalKind =
      TERMINAL_BY_API_NAME[apiName] ?? (status.isTerminal ? 'closed' : null);
    const pausesSla = PAUSING_API_NAMES.has(apiName);

    if (options.dryRun) {
      log(
        `[dry]  would classify status ${apiName || status._id} → ${terminalKind ?? 'non-terminal'}${pausesSla ? ', pauses SLA' : ''}`,
      );
      continue;
    }
    await statuses.updateOne(
      { _id: status._id },
      { $set: { terminalKind, pausesSla } },
    );
    report.statusesClassified++;
    if (pausesSla) report.statusesPausing++;
  }
  if (pending.length === 0)
    report.skipped.push('ticket_statuses already classified');
}

/**
 * Remove `closedAt` from tickets that only ever reached a `resolved` status.
 *
 * Such a stamp never happened: it came from a single write that set both
 * terminal timestamps. A ticket carrying it is invisible to the backlog, absent
 * from its owner's open work, and indistinguishable from a genuinely closed
 * case in every report.
 */
async function clearFabricatedCloseStamps(
  db: Db,
  options: { dryRun?: boolean },
  log: (message: string) => void,
  report: MigrationReport,
): Promise<void> {
  const resolvedStatusIds = await db
    .collection('ticket_statuses')
    .find({ terminalKind: 'resolved' })
    .project({ _id: 1 })
    .map((doc) => doc._id)
    .toArray();
  if (resolvedStatusIds.length === 0) {
    report.skipped.push('no resolved-kind statuses');
    return;
  }

  const filter = {
    statusId: { $in: resolvedStatusIds },
    closedAt: { $ne: null },
  };
  const count = await db.collection('tickets').countDocuments(filter);
  if (count === 0) {
    report.skipped.push('no fabricated close stamps');
    return;
  }
  if (options.dryRun) {
    log(
      `[dry]  would clear closedAt on ${count} resolved-but-not-closed tickets`,
    );
    return;
  }
  const result = await db
    .collection('tickets')
    .updateMany(filter, { $set: { closedAt: null } });
  report.closedStampsCleared = result.modifiedCount;
  log(`[ok]   cleared closedAt on ${result.modifiedCount} resolved tickets`);
}

/**
 * Mark every existing ticket as deliberately owned.
 *
 * Deliberately conservative. The alternative — treating the backlog as
 * unassigned so routing can distribute it — would have the engine reassign
 * every open ticket in every tenant within one cron tick of deploy, moving work
 * away from the agents currently handling it.
 */
async function backfillOwnerIntent(
  db: Db,
  options: { dryRun?: boolean },
  log: (message: string) => void,
  report: MigrationReport,
): Promise<void> {
  const filter = { ownerAssignedExplicitly: { $exists: false } };
  const count = await db.collection('tickets').countDocuments(filter);
  if (count === 0) {
    report.skipped.push('ownerAssignedExplicitly already set');
    return;
  }
  if (options.dryRun) {
    log(`[dry]  would mark ${count} existing tickets as explicitly owned`);
    return;
  }
  const result = await db.collection('tickets').updateMany(filter, [
    {
      $set: {
        ownerAssignedExplicitly: {
          $cond: [{ $ifNull: ['$ownerId', false] }, true, false],
        },
      },
    },
  ]);
  report.ownerIntentBackfilled = result.modifiedCount;
  log(`[ok]   set ownerAssignedExplicitly on ${result.modifiedCount} tickets`);
}

async function initialiseReopenCount(
  db: Db,
  options: { dryRun?: boolean },
  log: (message: string) => void,
  report: MigrationReport,
): Promise<void> {
  const filter = { reopenCount: { $exists: false } };
  const count = await db.collection('tickets').countDocuments(filter);
  if (count === 0) {
    report.skipped.push('reopenCount already initialised');
    return;
  }
  if (options.dryRun) {
    log(`[dry]  would initialise reopenCount on ${count} tickets`);
    return;
  }
  const result = await db
    .collection('tickets')
    .updateMany(filter, { $set: { reopenCount: 0 } });
  report.reopenCountsInitialised = result.modifiedCount;
  log(`[ok]   initialised reopenCount on ${result.modifiedCount} tickets`);
}

/** Every policy written before this change governed conversations. */
async function stampSlaPolicies(
  db: Db,
  options: { dryRun?: boolean },
  log: (message: string) => void,
  report: MigrationReport,
): Promise<void> {
  const filter = { appliesTo: { $exists: false } };
  const count = await db.collection('sla_policies').countDocuments(filter);
  if (count === 0) {
    report.skipped.push('sla_policies already stamped');
    return;
  }
  if (options.dryRun) {
    log(`[dry]  would stamp ${count} SLA policies as appliesTo=conversation`);
    return;
  }
  const result = await db
    .collection('sla_policies')
    .updateMany(filter, { $set: { appliesTo: 'conversation' } });
  report.policiesStamped = result.modifiedCount;
  log(`[ok]   stamped ${result.modifiedCount} SLA policies`);
}

/**
 * Rename `omni_sla_clocks` → `sla_clocks` and rekey its documents.
 *
 * The rename comes first so a crash between the two steps leaves the data in
 * the new collection with old field names — recoverable by re-running — rather
 * than split across two collections, where the breach cron would read one and
 * the projection write the other.
 */
async function migrateSlaClocks(
  db: Db,
  options: { dryRun?: boolean },
  log: (message: string) => void,
  report: MigrationReport,
): Promise<void> {
  const names = await db.listCollections().toArray();
  const hasLegacy = names.some((entry) => entry.name === 'omni_sla_clocks');
  const hasCurrent = names.some((entry) => entry.name === 'sla_clocks');

  if (hasLegacy && !hasCurrent) {
    if (options.dryRun) {
      log('[dry]  would rename omni_sla_clocks → sla_clocks');
    } else {
      await db.renameCollection('omni_sla_clocks', 'sla_clocks');
      report.clockCollectionRenamed = true;
      log('[ok]   renamed omni_sla_clocks → sla_clocks');
    }
  } else if (hasLegacy && hasCurrent) {
    // Both present means a partial previous run. The rekey below is keyed on
    // the absence of `subjectType`, so finishing the job is safe; the leftover
    // collection is reported rather than silently dropped.
    log(
      '[warn] both omni_sla_clocks and sla_clocks exist — rekeying sla_clocks only; ' +
        'drop omni_sla_clocks by hand once verified',
    );
  } else {
    report.skipped.push('no legacy clock collection');
  }

  const clocks = db.collection('sla_clocks');
  const filter = { subjectType: { $exists: false } };
  const count = await clocks.countDocuments(filter);

  if (count === 0) {
    report.skipped.push('clocks already rekeyed');
  } else if (options.dryRun) {
    log(`[dry]  would rekey ${count} clocks onto (subjectType, subjectId)`);
  } else {
    const result = await clocks.updateMany(filter, [
      { $set: { subjectType: 'conversation', subjectId: '$conversationId' } },
      { $unset: 'conversationId' },
    ]);
    report.clocksMigrated = result.modifiedCount;
    log(`[ok]   rekeyed ${result.modifiedCount} SLA clocks`);
  }

  // Always, even when there was nothing to rekey.
  //
  // An empty or already-rekeyed collection still carries the old indexes, and
  // the stale one is UNIQUE on `conversationId` — a field no document has any
  // more. Mongo indexes a missing field as null, so the key collapses to
  // (tenantId, null, metric, cycle) and the second subject in a tenant cannot
  // open a clock at all. Reconciling indexes only on the rekey path left every
  // fresh environment in exactly that state.
  await reconcileClockIndexes(clocks, options, log, report);
}

/** Bring `sla_clocks` indexes in line with the schema, whatever the data. */
async function reconcileClockIndexes(
  clocks: ReturnType<Db['collection']>,
  options: { dryRun?: boolean },
  log: (message: string) => void,
  report: MigrationReport,
): Promise<void> {
  const stale = ['sla_clock_cycle_unique', 'sla_clock_conversation_state'];
  const wanted: Array<{
    name: string;
    key: Record<string, 1 | -1>;
    unique?: boolean;
  }> = [
    {
      name: 'sla_clock_cycle_unique',
      key: { tenantId: 1, subjectType: 1, subjectId: 1, metric: 1, cycle: 1 },
      unique: true,
    },
    {
      name: 'sla_clock_subject_state',
      key: { tenantId: 1, subjectType: 1, subjectId: 1, status: 1 },
    },
  ];

  const existing = await clocks.indexes();
  const keyed = (key: Record<string, unknown>) => JSON.stringify(key);
  const alreadyCorrect = wanted.every((index) =>
    existing.some(
      (current) =>
        current.name === index.name && keyed(current.key) === keyed(index.key),
    ),
  );
  if (alreadyCorrect) {
    report.skipped.push('clock indexes already reconciled');
    return;
  }
  if (options.dryRun) {
    log('[dry]  would rebuild sla_clocks indexes onto subjectType/subjectId');
    return;
  }

  for (const name of stale) {
    const current = existing.find((index) => index.name === name);
    const target = wanted.find((index) => index.name === name);
    // Only drop what is actually wrong: an index already on the new key is the
    // answer, not something to rebuild.
    if (!current || (target && keyed(current.key) === keyed(target.key))) {
      continue;
    }
    await clocks.dropIndex(name);
    log(`[ok]   dropped stale index ${name}`);
  }
  for (const index of wanted) {
    await clocks.createIndex(index.key, {
      name: index.name,
      background: true,
      ...(index.unique ? { unique: true } : {}),
    });
    log(`[ok]   created ${index.name}`);
  }
  report.clockIndexesRebuilt = true;
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
        .collection('tickets')
        .estimatedDocumentCount()} tickets${dryRun ? ' (dry run)' : ''}`,
    );
    const report = await migrateTicketServiceDesk(
      db as unknown as Db,
      { dryRun },
      (line) => console.log(line),
    );
    console.log(
      `[done] statuses=${report.statusesClassified} pausing=${report.statusesPausing} ` +
        `closedCleared=${report.closedStampsCleared} ownerIntent=${report.ownerIntentBackfilled} ` +
        `reopenCount=${report.reopenCountsInitialised} policies=${report.policiesStamped} ` +
        `clocks=${report.clocksMigrated} renamed=${report.clockCollectionRenamed} ` +
        `clockIndexes=${report.clockIndexesRebuilt} skipped=${report.skipped.length}`,
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
