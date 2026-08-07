import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';
import { searchKeysPlugin } from '../../../../../common/search/search-keys.plugin';

export type DealSchemaDocument = HydratedDocument<DealSchemaClass>;

/**
 * One stage transition, kept on the deal itself.
 *
 * Contacts already carried `stageHistory[]`; deals did not, so "how long did this
 * sit in Negotiation" and "where do deals stall" were unanswerable without
 * replaying the audit log. `durationMs` is the time spent in `fromStageId`,
 * computed at write time — the alternative is a self-join over the array on every
 * report, and the value never changes once written.
 */
@Schema({ _id: false })
export class DealStageHistoryEntry {
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  fromStageId: string | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  toStageId: string;

  @Prop({ required: true })
  changedAt: Date;

  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  changedById: string | null;

  /** Milliseconds the deal spent in `fromStageId`. Null for the first entry. */
  @Prop({ type: Number, default: null })
  durationMs: number | null;
}

const DealStageHistoryEntrySchema = SchemaFactory.createForClass(
  DealStageHistoryEntry,
);

@Schema({
  timestamps: true,
  collection: 'deals',
  toJSON: {
    virtuals: true,
    getters: true,
  },
})
export class DealSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true, index: true })
  title: string;

  // `name` used to sit here: a second required, indexed field holding the same
  // string as `title`, kept in step by two hand-written assignments in the
  // service. Two sources for one value is a bug waiting for the third writer;
  // it cost an index on every write and answered no question `title` could not.

  /**
   * The pipeline this deal lives in.
   *
   * Was a free-text `pipeline: string` that no collection backed: the importer
   * wrote the literal `'default'` while the UI filtered by a `deal_pipelines`
   * ObjectId, so imported deals matched no pipeline filter at all and nothing
   * could enforce that `stageId` belonged to the same pipeline.
   */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'PipelineSchemaClass',
    required: true,
    index: true,
  })
  pipelineId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'DealStageSchemaClass',
    required: true,
    index: true,
  })
  stageId: string;

  /** Append-only transition log — see DealStageHistoryEntry. */
  @Prop({ type: [DealStageHistoryEntrySchema], default: [] })
  stageHistory: DealStageHistoryEntry[];

  /** When the deal entered its current stage. Drives "time in current stage". */
  @Prop({ type: Date, default: now })
  stageEnteredAt: Date;

  @Prop({ type: Number })
  probability?: number;

  @Prop({ default: 0 })
  value: number;

  @Prop({ default: 'USD' })
  currency: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'AccountSchemaClass' })
  accountId?: string;

  @Prop()
  accountName?: string;

  // Indexed by `tenant_contact_deals` below, not here: a bare multikey index on
  // an array field carries every tenant's deals in one B-tree, and no query ever
  // omits `tenantId`.
  @Prop({
    type: [{ type: MongooseSchema.Types.ObjectId, ref: 'ContactSchemaClass' }],
    default: [],
  })
  contactIds?: string[];

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  ownerId?: string;

  /**
   * True when a human picked the owner (create form, reassignment, import).
   *
   * `BaseDocumentRepository` stamps `ownerId` with the creator on every insert, so
   * "has an owner" could not distinguish a deliberate assignment from that default
   * — and the auto-assignment listener, which skips records that already have an
   * owner, therefore never ran for anything created through the API.
   */
  @Prop({ default: false })
  ownerAssignedExplicitly: boolean;

  // Set when DealOwnershipCleanupListener clears ownerId because the owner
  // left the tenant — surfaces the deal in an "unassigned" filter instead of
  // it silently falling out of every normal-scope owner/org-unit view.
  @Prop({ type: String, default: null })
  unassignedReason?: string | null;

  // Org-unit ownership: the node of the tenant's org tree this record belongs
  // to. Populated at create time from the record owner's org unit; read by the
  // 'org_unit' and 'org_unit_subtree' data scopes.
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null, index: true })
  orgUnitId?: string | null;

  @Prop()
  description?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'DealSourceSchemaClass' })
  sourceId?: string;

  /**
   * Campaign attribution, carried from the contact/landing page that produced
   * the deal.
   *
   * Flat keys rather than a nested object: every consumer is a report `$group`
   * or a list filter, and a flat key is what both an index and the generic
   * filter allowlist can address.
   */
  @Prop({ type: String, default: null })
  utmSource?: string | null;

  @Prop({ type: String, default: null })
  utmMedium?: string | null;

  @Prop({ type: String, default: null })
  utmCampaign?: string | null;

  @Prop()
  lostReason?: string;

  @Prop({ type: [String], default: [] })
  tags?: string[];

  @Prop({ type: MongooseSchema.Types.Mixed })
  customFields?: Record<string, any>;

  @Prop()
  closeDate?: Date;

  /**
   * When the owner has committed to touching this deal next.
   *
   * The single most load-bearing field for a B2C pipeline: without it "which
   * leads am I about to drop" has no answer. Read by DealFollowUpService (due
   * sweep) and by the `followUp` list filter.
   */
  @Prop({ type: Date, default: null })
  nextFollowUpAt?: Date | null;

  /** Set by the due sweep so a reminder is delivered at most once. */
  @Prop({ type: Date, default: null })
  followUpNotifiedAt?: Date | null;

  /**
   * Last time anything happened on this deal — an edit, a stage move, a logged
   * activity. Drives stale-deal detection, which `createdAt` cannot: a deal
   * worked daily for six months is not stale.
   */
  @Prop({ type: Date, default: now })
  lastActivityAt: Date;

  @Prop()
  wonAt?: Date;

  @Prop()
  lostAt?: Date;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
    index: true,
  })
  createdById: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
    index: true,
  })
  updatedById: string;

  @Prop({ default: now })
  createdAt: Date;

  @Prop({ default: now })
  updatedAt: Date;

  @Prop({ index: true })
  deletedAt?: Date;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'OmniConversationSchemaClass',
    default: null,
  })
  omniConversationId?: string;

  @Prop({
    type: [
      { type: MongooseSchema.Types.ObjectId, ref: 'OmniMessageSchemaClass' },
    ],
    default: [],
  })
  linkedMessageIds?: string[];
}

export const DealSchema = SchemaFactory.createForClass(DealSchemaClass);

DealSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// Free-text search. Replaces an unanchored `$regex` over title + accountName.
DealSchema.plugin(searchKeysPlugin, {
  fields: ['title', 'accountName', 'description', 'tags', 'customFields'],
});

DealSchema.index(
  { tenantId: 1, omniConversationId: 1 },
  { name: 'deal_omni_conversation' },
);
DealSchema.index({ tenantId: 1, ownerId: 1 }, { name: 'tenant_owner_lookup' });
DealSchema.index(
  { tenantId: 1, sourceId: 1 },
  { name: 'tenant_source_lookup' },
);
DealSchema.index(
  { tenantId: 1, createdAt: -1, _id: -1 },
  { name: 'tenant_created_cursor' },
);

// List sorts. One index per field in SORTABLE_FIELDS.Deal, each carrying the
// `_id` tie-breaker in the same direction so a page boundary cannot split two
// deals holding the same value. Mongo walks an index backwards, so one
// descending index serves both directions.
//
// "Biggest deals first" and "closing soonest" are the two questions a pipeline
// list exists to answer, and until now neither was expressible: the list was
// hard-sorted by `createdAt` and the UI offered no control at all.
DealSchema.index(
  { tenantId: 1, updatedAt: -1, _id: -1 },
  { name: 'tenant_updated_sort' },
);
DealSchema.index(
  { tenantId: 1, value: -1, _id: -1 },
  { name: 'tenant_value_sort' },
);
DealSchema.index(
  { tenantId: 1, closeDate: -1, _id: -1 },
  { name: 'tenant_close_date_sort' },
);

// The board is the primary read: one column = one (pipeline, stage) pair, sorted
// newest-first and keyset-paginated. This one index serves the column query, its
// count/sum aggregate, and the pipeline-filtered list.
DealSchema.index(
  { tenantId: 1, pipelineId: 1, stageId: 1, createdAt: -1, _id: -1 },
  { name: 'tenant_pipeline_stage_cursor' },
);

// Revenue Trend matches directly on these; without an index each report run was
// a collection scan over every deal the tenant has ever closed.
DealSchema.index(
  { tenantId: 1, wonAt: -1 },
  { name: 'tenant_won_at', sparse: true },
);
DealSchema.index(
  { tenantId: 1, lostAt: -1 },
  { name: 'tenant_lost_at', sparse: true },
);

// The follow-up sweep is cross-tenant and runs every five minutes, so it is
// driven by `nextFollowUpAt` alone; the partial filter keeps the index to the
// deals that actually have a commitment on them.
DealSchema.index(
  { nextFollowUpAt: 1 },
  {
    name: 'follow_up_due',
    partialFilterExpression: { nextFollowUpAt: { $type: 'date' } },
  },
);
DealSchema.index(
  { tenantId: 1, ownerId: 1, nextFollowUpAt: 1 },
  { name: 'tenant_owner_follow_up' },
);

// "This person's deals" — the contact timeline's deal source and the customer
// value rollup. Replaces the bare `contactIds` index declared on the field.
// Existing deployments: `db.deals.dropIndex('contactIds_1')`.
DealSchema.index(
  { tenantId: 1, contactIds: 1, wonAt: -1 },
  { name: 'tenant_contact_deals' },
);

DealSchema.virtual('owner', {
  ref: 'UserSchemaClass',
  localField: 'ownerId',
  foreignField: '_id',
  justOne: true,
});

DealSchema.virtual('dealStage', {
  ref: 'DealStageSchemaClass',
  localField: 'stageId',
  foreignField: '_id',
  justOne: true,
});

DealSchema.virtual('dealSource', {
  ref: 'DealSourceSchemaClass',
  localField: 'sourceId',
  foreignField: '_id',
  justOne: true,
});

DealSchema.virtual('pipeline', {
  ref: 'PipelineSchemaClass',
  localField: 'pipelineId',
  foreignField: '_id',
  justOne: true,
});
