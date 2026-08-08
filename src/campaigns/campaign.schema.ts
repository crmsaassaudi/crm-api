import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../utils/document-entity-helper';
import { tenantFilterPlugin } from '../common/plugins/tenant-filter.plugin';
import {
  CAMPAIGN_CHANNELS,
  CampaignChannelConfig,
} from './domain/campaign-channel';
import { QuietHours } from './domain/quiet-hours';
// Type-only: this file is loaded by ContactsModule (the segment delete guard
// reads campaigns), so a value import back into contacts/ would close a require
// cycle that `emitDecoratorMetadata` makes fatal at boot.
import type { AudienceDefinition } from '../contacts/audience/audience-definition';

export type CampaignDocument = HydratedDocument<CampaignSchemaClass>;

/**
 * Campaign lifecycle.
 *
 *   draft ─┬─→ scheduled ─→ sending ─→ completed
 *          └─→ sending ─→ completed          (launch now)
 *   sending ⇄ paused
 *   scheduled | sending | paused ─→ cancelled
 *
 * `completed` means every recipient reached a terminal state, NOT that every
 * send succeeded: a campaign whose 1000 sends all failed is completed with 1000
 * failures, which keeps "did it finish" separate from "did it work".
 */
export const CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'sending',
  'paused',
  'completed',
  'cancelled',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Statuses from which the definition may still be edited. */
export const EDITABLE_CAMPAIGN_STATUSES: readonly CampaignStatus[] = [
  'draft',
  'scheduled',
];

@Schema({ timestamps: true, collection: 'campaigns' })
export class CampaignSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  /** Human-quotable identifier, `CMP-00001`. Assigned once, never reused. */
  @Prop({ required: true })
  code: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ trim: true })
  description?: string;

  @Prop({ trim: true })
  objective?: string;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({
    type: String,
    required: true,
    enum: CAMPAIGN_STATUSES,
    default: 'draft',
  })
  status: CampaignStatus;

  /**
   * Split from `channelConfig` so the list view can filter and group by channel
   * without reaching into a Mixed field — an index cannot serve a predicate on
   * `channelConfig.type`.
   */
  @Prop({ type: String, required: true, enum: CAMPAIGN_CHANNELS })
  channelType: CampaignChannelConfig['type'];

  /**
   * The channel's content and sender, shaped by `channelType`.
   *
   * Mixed because the three channels share almost no fields; validated by
   * `assertChannelConfig` on write and again in the worker before the first
   * send, since Mongo enforces nothing here.
   */
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  channelConfig: CampaignChannelConfig;

  /**
   * Who receives it.
   *
   * An `AudienceDefinition`: saved segments and inline condition trees, unioned,
   * minus anything in `exclude`. Mixed for the same reason as `channelConfig` —
   * it is a tree whose shape Mongo cannot usefully enforce — and validated by
   * `assertAudienceShape` plus a real compile on every write, so an audience that
   * cannot resolve is refused where the author can still see why.
   *
   * A definition, not a resolved list: while a campaign is a draft it should
   * follow its segments as they change. The moment it launches, `audienceSnapshot`
   * freezes it.
   */
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  audience: AudienceDefinition;

  /**
   * The audience as it stood at launch: the definition, and the compiled
   * predicate the run actually walks.
   *
   * The predicate is what makes a run self-contained. Re-resolving the
   * definition in the worker would let a segment edited five minutes after
   * launch change who is mid-send, and a segment DELETED after launch would
   * fail the job outright — at 3am, with nobody watching. Freezing it also means
   * "why did this person receive this" stays answerable after the segment is
   * gone.
   *
   * `select: false`: the compiled predicate is an internal detail and has no
   * business in an API response.
   */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null, select: false })
  audienceSnapshot?: {
    definition: AudienceDefinition;
    predicate: Record<string, unknown>;
    frozenAt: Date;
  } | null;

  @Prop({
    type: {
      /** Absent means "send as soon as it is launched". */
      sendAt: { type: Date, default: null },
      timezone: { type: String, default: 'UTC' },
      quietHours: {
        type: { start: String, end: String },
        default: null,
        _id: false,
      },
    },
    default: () => ({ sendAt: null, timezone: 'UTC', quietHours: null }),
    _id: false,
  })
  schedule: {
    sendAt?: Date | null;
    timezone: string;
    quietHours?: QuietHours | null;
  };

  /**
   * Denormalised counters, incremented by the send worker with `$inc`.
   *
   * Derived data — the recipient ledger is the source of truth — but a campaign
   * detail page that had to `countDocuments` five times over a 500k-row ledger
   * on every poll is the reason these live here.
   */
  @Prop({
    type: {
      audienceSize: { type: Number, default: 0 },
      queued: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
    },
    default: () => ({
      audienceSize: 0,
      queued: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
    }),
    _id: false,
  })
  stats: {
    audienceSize: number;
    queued: number;
    sent: number;
    failed: number;
    skipped: number;
  };

  /** Planned spend. Recorded by the marketer; nothing computes against it. */
  @Prop()
  budget?: number;

  @Prop()
  currency?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  ownerId?: string;

  /** Org-unit ownership, read by the `org_unit` data scopes. */
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null, index: true })
  orgUnitId?: string | null;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  createdById: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  updatedById: string;

  // Every nullable field carries an explicit `type`. A `Date | null` annotation
  // is an ambiguous union to Mongoose's reflection, and it refuses to build the
  // schema at boot — which no type-check catches.
  @Prop({ type: Date, default: null })
  launchedAt?: Date | null;

  @Prop({ type: Date, default: null })
  completedAt?: Date | null;

  /** Why a launch was refused or a run stopped. Shown on the detail page. */
  @Prop()
  lastError?: string;

  /**
   * The launcher's row-level visibility, captured when the campaign was launched.
   *
   * A campaign must reach exactly the people its author could see — messaging a
   * contact you are not allowed to read is a disclosure, not a feature. The
   * worker has no request to derive that from, and a campaign scheduled for next
   * Tuesday is dispatched by a sweep with no user context at all, so the snapshot
   * has to live here rather than only in the job payload.
   *
   * `select: false`: it is an internal authorisation detail and has no business
   * appearing in an API response.
   */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null, select: false })
  runScope?: Record<string, unknown> | null;

  /**
   * Soft-deleted, unlike a contact segment: the recipient ledger and every
   * report that joins to it reference this document by id, so a hard delete
   * would leave rows pointing at nothing.
   */
  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;

  @Prop({ default: now })
  createdAt: Date;

  @Prop({ default: now })
  updatedAt: Date;
}

export const CampaignSchema = SchemaFactory.createForClass(CampaignSchemaClass);

CampaignSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// One code per tenant, forever — including across soft deletes, because the code
// is what a person quotes when asking why they received a message.
CampaignSchema.index(
  { tenantId: 1, code: 1 },
  { name: 'tenant_campaign_code', unique: true },
);

// The default list view. Partial on live campaigns only: every list read filters
// `deletedAt: null`, and Mongo cannot use a plain index selectively for a null
// match — it would still walk the deleted entries.
CampaignSchema.index(
  { tenantId: 1, createdAt: -1, _id: -1 },
  {
    name: 'tenant_campaign_list',
    partialFilterExpression: { deletedAt: null },
  },
);

CampaignSchema.index(
  { tenantId: 1, status: 1, createdAt: -1 },
  {
    name: 'tenant_campaign_status',
    partialFilterExpression: { deletedAt: null },
  },
);

// Drives the due-campaign sweep, which asks one question: which scheduled
// campaigns are past their send time? Partial so the index holds only the
// handful of campaigns actually waiting, not every campaign ever sent.
CampaignSchema.index(
  { 'schedule.sendAt': 1 },
  {
    name: 'campaign_due_sweep',
    partialFilterExpression: { status: 'scheduled', deletedAt: null },
  },
);

CampaignSchema.index(
  { tenantId: 1, ownerId: 1 },
  { name: 'tenant_campaign_owner' },
);
