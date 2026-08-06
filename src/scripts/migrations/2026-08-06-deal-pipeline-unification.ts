/**
 * Moves deals off the free-text `deal.pipeline` string and onto a real
 * `deal_pipelines` document, then gives every existing deal and stage the fields
 * the module now depends on. Background: `docs/audit/DEAL_MODULE_REMEDIATION_2026-08-06.md`.
 *
 * Per tenant: (1) one default pipeline, (2) stages repointed at it as ObjectId
 * with real `isWon`/`isLost`/`isDefault` booleans and one landing stage,
 * (3) `pipeline` → `pipelineId` on deals, (4) `stageEnteredAt` / `lastActivityAt`
 * / `stageHistory` / `ownerAssignedExplicitly` / follow-up fields backfilled,
 * (5) the dead `crm_settings.deal_pipeline` blob deleted, (6) the indexes
 * declared in `deal.schema.ts` created — autoIndex is off in production, so
 * declaring one there does not create it.
 *
 * Idempotent: every step is a no-op on a second run.
 * Run: npm run migrate:deal-pipeline-unification
 */
import 'dotenv/config';
import mongoose, { mongo } from 'mongoose';

// Taken from mongoose's own driver, not the top-level `mongodb` package. The two
// resolve to different majors here, and an ObjectId minted by one is rejected by
// the other's serializer ("bson types must be from bson 6.x.x") the moment it is
// sent over the wire.
type Db = mongo.Db;
type ObjectId = mongo.ObjectId;
const { ObjectId } = mongo;

const DEFAULT_STAGES = [
  {
    label: 'New Lead',
    apiName: 'new_lead',
    probability: 10,
    color: '#64748b',
    isDefault: true,
  },
  {
    label: 'Contacted',
    apiName: 'contacted',
    probability: 25,
    color: '#3b82f6',
  },
  {
    label: 'Interested',
    apiName: 'interested',
    probability: 50,
    color: '#8b5cf6',
  },
  {
    label: 'Negotiation',
    apiName: 'negotiation',
    probability: 75,
    color: '#f59e0b',
  },
  {
    label: 'Won',
    apiName: 'won',
    probability: 100,
    color: '#10b981',
    isWon: true,
  },
  {
    label: 'Lost',
    apiName: 'lost',
    probability: 0,
    color: '#ef4444',
    isLost: true,
  },
];

interface PlannedIndex {
  name: string;
  key: Record<string, 1 | -1>;
  options?: Record<string, unknown>;
  why: string;
}

/** Must stay in step with the index block in `deal.schema.ts`. */
export const PLANNED_DEAL_INDEXES: PlannedIndex[] = [
  {
    name: 'tenant_pipeline_stage_cursor',
    key: { tenantId: 1, pipelineId: 1, stageId: 1, createdAt: -1, _id: -1 },
    why: 'board column read, its count/sum aggregate, and the pipeline-filtered list',
  },
  {
    name: 'tenant_created_cursor',
    key: { tenantId: 1, createdAt: -1, _id: -1 },
    why: 'default list, keyset-paginated',
  },
  {
    name: 'tenant_owner_lookup',
    key: { tenantId: 1, ownerId: 1 },
    why: '"my deals" and the owner data scope',
  },
  {
    name: 'tenant_source_lookup',
    key: { tenantId: 1, sourceId: 1 },
    why: 'attribution reporting',
  },
  {
    name: 'tenant_won_at',
    key: { tenantId: 1, wonAt: -1 },
    options: { sparse: true },
    why: 'revenue trend; previously a collection scan per report run',
  },
  {
    name: 'tenant_lost_at',
    key: { tenantId: 1, lostAt: -1 },
    options: { sparse: true },
    why: 'loss trend; same',
  },
  {
    name: 'follow_up_due',
    key: { nextFollowUpAt: 1 },
    options: {
      partialFilterExpression: { nextFollowUpAt: { $type: 'date' } },
    },
    why: 'cross-tenant follow-up sweep, every five minutes',
  },
  {
    name: 'tenant_owner_follow_up',
    key: { tenantId: 1, ownerId: 1, nextFollowUpAt: 1 },
    why: "a rep's overdue queue",
  },
  {
    name: 'deal_omni_conversation',
    key: { tenantId: 1, omniConversationId: 1 },
    why: 'omni sidebar',
  },
];

/** Indexes to remove, with the reason recorded so nobody recreates them. */
const OBSOLETE = [
  {
    match: (key: Record<string, unknown>) =>
      Object.keys(key).length === 2 && key.tenantId === 1 && key.stageId === 1,
    why: 'superseded by tenant_pipeline_stage_cursor, which every board query uses',
  },
  {
    match: (key: Record<string, unknown>) =>
      Object.keys(key).length === 4 &&
      key.tenantId === 1 &&
      key.stageId === 1 &&
      key.createdAt === -1,
    why: 'keyed a stage without its pipeline; replaced by tenant_pipeline_stage_cursor',
  },
  {
    match: (key: Record<string, unknown>) =>
      Object.keys(key).length === 1 && key.pipeline === 1,
    why: 'keys `pipeline`, the free-text column this migration removes',
  },
];

export interface DealMigrationReport {
  tenants: number;
  pipelinesCreated: number;
  stagesRepointed: number;
  stagesNormalised: number;
  stagesReordered: number;
  landingStagesSet: number;
  pipelinesWithoutWonStage: number;
  pipelinesWithoutLostStage: number;
  dealsRepointed: number;
  dealsBackfilled: number;
  legacyBlobsRemoved: number;
  indexesCreated: string[];
  indexesDropped: string[];
}

const sameKey = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return (
    ak.length === bk.length &&
    ak.every((key, index) => bk[index] === key && a[key] === b[key])
  );
};

/** One idempotent pass. `log` is injectable so tests stay quiet. */
export async function migrateDealPipelines(
  db: Db,
  log: (message: string) => void = () => {},
): Promise<DealMigrationReport> {
  const deals = db.collection('deals');
  const pipelines = db.collection('deal_pipelines');
  const stages = db.collection('deal_stages');
  const settings = db.collection('crm_settings');

  const report: DealMigrationReport = {
    tenants: 0,
    pipelinesCreated: 0,
    stagesRepointed: 0,
    stagesNormalised: 0,
    stagesReordered: 0,
    landingStagesSet: 0,
    pipelinesWithoutWonStage: 0,
    pipelinesWithoutLostStage: 0,
    dealsRepointed: 0,
    dealsBackfilled: 0,
    legacyBlobsRemoved: 0,
    indexesCreated: [],
    indexesDropped: [],
  };

  // Every tenant that owns a deal, a stage or a pipeline. Derived rather than
  // read from `tenants`, so a workspace whose tenant row was archived still gets
  // its data migrated instead of being left on the old shape.
  const tenantIds = new Set<string>();
  for (const collection of [deals, stages, pipelines]) {
    for (const id of await collection.distinct('tenantId')) {
      if (id) tenantIds.add(String(id));
    }
  }
  report.tenants = tenantIds.size;

  for (const raw of tenantIds) {
    const tenantId = new ObjectId(raw);

    // 1. One default pipeline.
    let pipeline = await pipelines.findOne({
      tenantId,
      isArchived: { $ne: true },
    });
    if (!pipeline) {
      const insert = await pipelines.insertOne({
        tenantId,
        name: 'Sales Pipeline',
        description: null,
        color: null,
        isDefault: true,
        isArchived: false,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      pipeline = await pipelines.findOne({ _id: insert.insertedId });
      report.pipelinesCreated++;
      log(`[ok]   tenant ${raw}: created default pipeline`);
    }
    const pipelineId = pipeline!._id;

    // Exactly one default, so `resolvePlacement` is deterministic.
    await pipelines.updateMany(
      { tenantId, _id: { $ne: pipelineId } },
      { $set: { isDefault: false } },
    );
    await pipelines.updateOne(
      { _id: pipelineId },
      { $set: { isDefault: true } },
    );

    // 2. Stages point at it as an ObjectId.
    const repointed = await stages.updateMany(
      { tenantId, pipelineId: { $not: { $type: 'objectId' } } },
      { $set: { pipelineId } },
    );
    report.stagesRepointed += repointed.modifiedCount;

    // A tenant with deals but no stages cannot be left stageless — every write
    // path now resolves a placement before it can insert.
    if ((await stages.countDocuments({ tenantId })) === 0) {
      await stages.insertMany(
        DEFAULT_STAGES.map((stage, index) => ({
          isDefault: false,
          isWon: false,
          isLost: false,
          ...stage,
          tenantId,
          pipelineId,
          sortOrder: index,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      );
      log(`[ok]   tenant ${raw}: seeded ${DEFAULT_STAGES.length} stages`);
    }

    // 2b. The flags every write path now reads must exist as booleans.
    //
    // Stages created before this module carried no `isWon`/`isLost`/`isDefault`
    // at all. Absent is not the same as false here: `resolvePlacement` picks a
    // deal's landing stage with `{ isDefault: -1, sortOrder: 1 }`, so a set of
    // stages with no default and no distinct order sends every new deal to
    // whichever row the server happens to return first.
    const normalised = await stages.updateMany(
      {
        tenantId,
        $or: [
          { isWon: { $exists: false } },
          { isLost: { $exists: false } },
          { isDefault: { $exists: false } },
        ],
      },
      [
        {
          $set: {
            isWon: { $eq: [{ $ifNull: ['$isWon', false] }, true] },
            isLost: { $eq: [{ $ifNull: ['$isLost', false] }, true] },
            isDefault: { $eq: [{ $ifNull: ['$isDefault', false] }, true] },
          },
        },
      ] as any,
    );
    report.stagesNormalised += normalised.modifiedCount;

    const pipelineStages = await stages
      .find({ tenantId, pipelineId })
      .sort({ sortOrder: 1, _id: 1 })
      .toArray();

    // Colliding sortOrder means the board draws its columns in an order nobody
    // chose. Rewritten only when they actually collide, so a deliberate order is
    // never disturbed.
    const distinctOrders = new Set(
      pipelineStages.map((stage) => stage.sortOrder),
    );
    if (
      pipelineStages.length > 0 &&
      distinctOrders.size !== pipelineStages.length
    ) {
      await stages.bulkWrite(
        pipelineStages.map((stage, index) => ({
          updateOne: {
            filter: { _id: stage._id },
            update: { $set: { sortOrder: index } },
          },
        })),
      );
      report.stagesReordered += pipelineStages.length;
      log(
        `[ok]   tenant ${raw}: gave ${pipelineStages.length} stages a distinct order`,
      );
    }

    // Exactly one landing stage, and never a closed one — a deal that opened
    // straight into Won would skip the whole pipeline.
    if (
      pipelineStages.length > 0 &&
      !pipelineStages.some((stage) => stage.isDefault === true)
    ) {
      const landing =
        pipelineStages.find(
          (stage) => stage.isWon !== true && stage.isLost !== true,
        ) ?? pipelineStages[0];
      await stages.updateOne(
        { _id: landing._id },
        { $set: { isDefault: true } },
      );
      report.landingStagesSet++;
      log(`[ok]   tenant ${raw}: "${landing.label}" is now the landing stage`);
    }

    // Won and Lost are load-bearing, not decoration: without them no deal can
    // ever be closed, the lost-reason requirement never fires, and the win-rate
    // and loss-analysis reports read an empty set. Which stage carries the
    // meaning is the admin's decision though, not something to infer from a
    // label, so this reports the gap instead of repairing it.
    if (!pipelineStages.some((stage) => stage.isWon === true)) {
      report.pipelinesWithoutWonStage++;
      log(
        `[warn] tenant ${raw}: no stage is marked Won — deals cannot be closed as won`,
      );
    }
    if (!pipelineStages.some((stage) => stage.isLost === true)) {
      report.pipelinesWithoutLostStage++;
      log(
        `[warn] tenant ${raw}: no stage is marked Lost — deals cannot be closed as lost`,
      );
    }

    const stageIds = (
      await stages.find({ tenantId }).project({ _id: 1 }).toArray()
    ).map((stage) => stage._id);
    const fallbackStage = await stages.findOne(
      { tenantId, pipelineId },
      { sort: { isDefault: -1, sortOrder: 1 } },
    );

    // 3. Deals carry `pipelineId`, and a stage that actually exists.
    //
    // Scoped to deals that do not already have one. An unconditional `$set`
    // would be correct on the first run and destructive on the second: once a
    // tenant has built a second pipeline and moved deals into it, re-running
    // this would drag every one of them back to the default.
    const dealsRepointed = await deals.updateMany(
      { tenantId, pipelineId: { $not: { $type: 'objectId' } } },
      { $set: { pipelineId }, $unset: { pipeline: '' } },
    );
    report.dealsRepointed += dealsRepointed.modifiedCount;

    if (fallbackStage) {
      await deals.updateMany(
        { tenantId, stageId: { $nin: stageIds } },
        { $set: { stageId: fallbackStage._id } },
      );
    }

    // 4. Fields the module now reads on every deal.
    const backfilled = await deals.updateMany(
      { tenantId, lastActivityAt: { $exists: false } },
      [
        {
          $set: {
            stageEnteredAt: { $ifNull: ['$updatedAt', '$createdAt'] },
            lastActivityAt: { $ifNull: ['$updatedAt', '$createdAt'] },
            // Pre-migration owners were all set by the create default, so none
            // of them is evidence a human chose that owner. Marking them
            // explicit is the safe direction: auto-assignment will not
            // reassign a deal out from under the rep who is working it.
            ownerAssignedExplicitly: true,
            nextFollowUpAt: null,
            followUpNotifiedAt: null,
            utmSource: null,
            utmMedium: null,
            utmCampaign: null,
            unassignedReason: { $ifNull: ['$unassignedReason', null] },
            // One synthetic entry so the funnel report has a floor to measure
            // from. `durationMs: null` marks it as reconstructed, not observed.
            stageHistory: [
              {
                fromStageId: null,
                toStageId: '$stageId',
                changedAt: '$createdAt',
                changedById: '$createdById',
                durationMs: null,
              },
            ],
          },
        },
      ] as any,
    );
    report.dealsBackfilled += backfilled.modifiedCount;

    // 5. The dead settings blob.
    const removed = await settings.deleteMany({
      tenantId: { $in: [tenantId, raw] },
      key: 'deal_pipeline',
    });
    report.legacyBlobsRemoved += removed.deletedCount;
  }

  // 6. Indexes. autoIndex is off in production, so the schema is not evidence.
  let existing = await deals.indexes();

  for (const obsolete of OBSOLETE) {
    const found = existing.find(
      (index) => index.name !== '_id_' && obsolete.match(index.key as any),
    );
    if (found?.name) {
      await deals.dropIndex(found.name);
      report.indexesDropped.push(found.name);
      log(`[ok]   dropped ${found.name} — ${obsolete.why}`);
      existing = await deals.indexes();
    }
  }

  for (const planned of PLANNED_DEAL_INDEXES) {
    const byName = existing.find((index) => index.name === planned.name);
    if (byName) {
      if (sameKey(byName.key as any, planned.key)) {
        log(`[skip] ${planned.name} already present`);
        continue;
      }
      // Same name, different key: createIndex refuses a conflicting redefinition.
      await deals.dropIndex(planned.name);
      report.indexesDropped.push(planned.name);
      existing = await deals.indexes();
    }

    await deals.createIndex(planned.key, {
      name: planned.name,
      background: true,
      ...(planned.options ?? {}),
    });
    report.indexesCreated.push(planned.name);
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
    // database nobody uses.
    console.log(
      `[db] ${db.databaseName} — ${await db
        .collection('deals')
        .estimatedDocumentCount()} deal(s)`,
    );
    const report = await migrateDealPipelines(db, (message) =>
      console.log(message),
    );
    console.log(`\n[done] ${JSON.stringify(report, null, 2)}`);
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
