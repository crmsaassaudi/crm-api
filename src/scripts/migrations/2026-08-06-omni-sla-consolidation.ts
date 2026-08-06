/**
 * Omni SLA consolidation — one clock engine, and the handling timeline.
 *
 * The module ran two SLA implementations at once. The one every consumer read
 * stored `frtDeadline` / `frtBreached` / `resolutionDeadline` /
 * `resolutionBreached` on the conversation and cancelled its breach job on an
 * event name nobody emitted, so those flags recorded "still open at the deadline",
 * not "answered late". They are removed here along with their indexes; `sla_clocks`
 * is now the only engine and `slaBreached` / `slaDueAt` the projection the inbox
 * filters on.
 *
 * The conversation also gained the four facts every contact-centre metric derives
 * from — `firstRespondedAt`, `firstResponderId`, `queuedAt`, `totalQueuedMs` — plus
 * `assignedAt`. This backfills what can be known from data already on disk:
 *
 *   - `firstRespondedAt` / `firstResponderId` from the earliest outbound agent
 *     message in `omni_messages`. Recoverable exactly, because the messages were
 *     always there; only the conversation-level summary was missing.
 *   - `slaBreached` from any breached clock in `omni_sla_clocks`.
 *   - `queuedAt` for conversations sitting unowned, so the queue console does not
 *     report a fleet of zero-second waits on its first render.
 *
 * `assignedAt` and `totalQueuedMs` are NOT invented: nothing on disk records when
 * a conversation was picked up. They stay null/0 and become accurate from the
 * first assignment after deploy. A fabricated wait time is worse than an absent
 * one — it would be indistinguishable from a measured one.
 *
 * Idempotent: re-running recomputes the same values from the same messages and
 * skips indexes that already match.
 *
 * Run:
 *   npm run migrate:omni-sla-consolidation -- --dry-run
 *   npm run migrate:omni-sla-consolidation
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

/** Must stay in step with the index block in omni-conversation.schema.ts. */
export const PLANNED_INDEXES: PlannedIndex[] = [
  {
    collection: 'omni_conversations',
    name: 'conversation_sla',
    key: { tenantId: 1, slaBreached: 1, slaDueAt: 1 },
    why: 'inbox SLA filter: "breached" is the equality prefix, "due soon" the range',
  },
  {
    collection: 'omni_conversations',
    name: 'conversation_queue_wait',
    key: { tenantId: 1, assignedGroupId: 1, queuedAt: 1 },
    options: { partialFilterExpression: { queuedAt: { $type: 'date' } } },
    why: 'supervisor queue console, longest wait first; partial so it holds only what is actually queued',
  },
  {
    collection: 'omni_conversations',
    name: 'firstResponderId_1',
    key: { tenantId: 1, firstResponderId: 1 },
    why: 'agent performance is grouped by who answered, not by the current assignee',
  },
];

/** Indexes whose fields no longer exist. */
export const OBSOLETE_INDEXES = [
  {
    collection: 'omni_conversations',
    name: 'frtDeadline_1',
    why: 'frtDeadline removed — the legacy SLA engine it belonged to is deleted',
  },
  {
    collection: 'omni_conversations',
    name: 'resolutionDeadline_1',
    why: 'resolutionDeadline removed with the legacy SLA engine',
  },
];

/** Conversation fields the legacy engine owned. */
export const REMOVED_FIELDS = [
  'frtPolicyId',
  'frtDeadline',
  'frtBreached',
  'resolutionPolicyId',
  'resolutionDeadline',
  'resolutionBreached',
] as const;

export interface MigrationReport {
  created: string[];
  dropped: string[];
  skipped: string[];
  fieldsStripped: number;
  firstResponsesBackfilled: number;
  breachesProjected: number;
  queuedAtBackfilled: number;
}

export async function migrateOmniSlaConsolidation(
  db: Db,
  options: { dryRun?: boolean } = {},
  log: (message: string) => void = () => {},
): Promise<MigrationReport> {
  const report: MigrationReport = {
    created: [],
    dropped: [],
    skipped: [],
    fieldsStripped: 0,
    firstResponsesBackfilled: 0,
    breachesProjected: 0,
    queuedAtBackfilled: 0,
  };

  await dropObsoleteIndexes(db, options, log, report);
  await createPlannedIndexes(db, options, log, report);

  report.firstResponsesBackfilled = await backfillFirstResponse(
    db,
    options,
    log,
  );
  report.breachesProjected = await projectBreachedClocks(db, options, log);
  report.queuedAtBackfilled = await backfillQueuedAt(db, options, log);
  report.fieldsStripped = await stripLegacyFields(db, options, log);

  return report;
}

async function dropObsoleteIndexes(
  db: Db,
  options: { dryRun?: boolean },
  log: (message: string) => void,
  report: MigrationReport,
): Promise<void> {
  for (const obsolete of OBSOLETE_INDEXES) {
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
}

async function createPlannedIndexes(
  db: Db,
  options: { dryRun?: boolean },
  log: (message: string) => void,
  report: MigrationReport,
): Promise<void> {
  for (const planned of PLANNED_INDEXES) {
    const collection = db.collection(planned.collection);
    const label = `${planned.collection}.${planned.name}`;
    const existing = await collection.indexes();
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
}

/**
 * Recover the first agent reply per conversation from the message log.
 *
 * Driven from `omni_messages` with `$sort` + `$group.$first`, one pass, rather
 * than a query per conversation. Only conversations that were actually answered
 * appear, which is the point: the rest correctly keep a null first response.
 */
async function backfillFirstResponse(
  db: Db,
  options: { dryRun?: boolean },
  log: (message: string) => void,
): Promise<number> {
  const rows = db.collection('omni_messages').aggregate(
    [
      { $match: { senderType: 'agent', direction: 'outbound' } },
      { $sort: { conversationId: 1, createdAt: 1 } },
      {
        $group: {
          _id: '$conversationId',
          tenantId: { $first: '$tenantId' },
          firstRespondedAt: { $first: '$createdAt' },
          firstResponderId: { $first: '$senderId' },
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
      await db.collection('omni_conversations').bulkWrite(batch, {
        ordered: false,
      });
    }
    processed += batch.length;
    batch = [];
  };

  for await (const row of rows) {
    batch.push({
      updateOne: {
        // `firstRespondedAt: null` keeps the pass idempotent and stops it
        // overwriting a value the running system has already recorded.
        filter: {
          _id: row._id,
          tenantId: row.tenantId,
          firstRespondedAt: null,
        },
        update: {
          $set: {
            firstRespondedAt: row.firstRespondedAt,
            firstResponderId: toObjectId(row.firstResponderId),
          },
        },
      },
    });
    if (batch.length >= 1_000) await flush();
  }
  await flush();

  log(
    `${options.dryRun ? '[dry]  would backfill' : '[ok]   backfilled'} ` +
      `${processed} first response(s) from omni_messages`,
  );
  return processed;
}

/** Carry existing clock breaches onto the conversation projection. */
async function projectBreachedClocks(
  db: Db,
  options: { dryRun?: boolean },
  log: (message: string) => void,
): Promise<number> {
  const rows = db.collection('omni_sla_clocks').aggregate([
    { $match: { status: 'breached' } },
    {
      $group: {
        _id: '$conversationId',
        tenantId: { $first: '$tenantId' },
        breachedAt: { $min: '$breachedAt' },
      },
    },
  ]);

  let processed = 0;
  let batch: any[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    if (!options.dryRun) {
      await db
        .collection('omni_conversations')
        .bulkWrite(batch, { ordered: false });
    }
    processed += batch.length;
    batch = [];
  };

  for await (const row of rows) {
    batch.push({
      updateOne: {
        filter: { _id: row._id, tenantId: row.tenantId },
        update: {
          $set: { slaBreached: true, slaBreachedAt: row.breachedAt ?? null },
        },
      },
    });
    if (batch.length >= 1_000) await flush();
  }
  await flush();

  log(
    `${options.dryRun ? '[dry]  would project' : '[ok]   projected'} ` +
      `${processed} existing clock breach(es) onto conversations`,
  );
  return processed;
}

/**
 * Give conversations that are waiting right now a `queuedAt`.
 *
 * `lastMessageAt` (falling back to `createdAt`) is the closest defensible
 * approximation of when this customer started waiting, and without it every
 * currently-queued conversation would render as a zero-second wait on the first
 * load of the queue console — which reads as "nobody is waiting".
 */
async function backfillQueuedAt(
  db: Db,
  options: { dryRun?: boolean },
  log: (message: string) => void,
): Promise<number> {
  const filter = {
    status: { $in: ['open', 'pending'] },
    assignedAgentId: null,
    queuedAt: null,
  };

  if (options.dryRun) {
    const count = await db
      .collection('omni_conversations')
      .countDocuments(filter);
    log(`[dry]  would stamp queuedAt on ${count} waiting conversation(s)`);
    return count;
  }

  const result = await db.collection('omni_conversations').updateMany(filter, [
    {
      $set: {
        queuedAt: { $ifNull: ['$lastMessageAt', '$createdAt'] },
      },
    },
  ]);
  log(
    `[ok]   stamped queuedAt on ${result.modifiedCount} waiting conversation(s)`,
  );
  return result.modifiedCount;
}

/** Remove the legacy engine's fields. Runs last, so the backfills can read them. */
async function stripLegacyFields(
  db: Db,
  options: { dryRun?: boolean },
  log: (message: string) => void,
): Promise<number> {
  const filter = {
    $or: REMOVED_FIELDS.map((field) => ({ [field]: { $exists: true } })),
  };

  if (options.dryRun) {
    const count = await db
      .collection('omni_conversations')
      .countDocuments(filter);
    log(
      `[dry]  would strip ${REMOVED_FIELDS.join(', ')} from ${count} conversation(s)`,
    );
    return count;
  }

  const result = await db.collection('omni_conversations').updateMany(filter, {
    $unset: Object.fromEntries(REMOVED_FIELDS.map((field) => [field, ''])),
  });
  log(
    `[ok]   stripped legacy SLA fields from ${result.modifiedCount} conversation(s)`,
  );
  return result.modifiedCount;
}

function sameKey(a: Record<string, unknown>, b: Record<string, unknown>) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return (
    ak.length === bk.length &&
    ak.every((key, index) => bk[index] === key && a[key] === b[key])
  );
}

/**
 * `senderId` on an agent message is the user id as a string; `firstResponderId`
 * is an ObjectId ref, and a string there would never match a `$lookup`.
 */
function toObjectId(value: unknown): mongoose.Types.ObjectId | null {
  const raw = value == null ? '' : String(value);
  return mongoose.Types.ObjectId.isValid(raw)
    ? new mongoose.Types.ObjectId(raw)
    : null;
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
        .collection('omni_conversations')
        .estimatedDocumentCount()} conversations${dryRun ? ' (dry run)' : ''}`,
    );
    // Mongoose bundles its own `mongodb` copy; the two `Db` types are
    // structurally identical but nominally distinct.
    const report = await migrateOmniSlaConsolidation(
      db as unknown as Db,
      { dryRun },
      (line) => console.log(line),
    );
    console.log(
      `[done] created=${report.created.length} dropped=${report.dropped.length} ` +
        `skipped=${report.skipped.length} ` +
        `firstResponses=${report.firstResponsesBackfilled} ` +
        `breaches=${report.breachesProjected} ` +
        `queued=${report.queuedAtBackfilled} ` +
        `stripped=${report.fieldsStripped}`,
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
