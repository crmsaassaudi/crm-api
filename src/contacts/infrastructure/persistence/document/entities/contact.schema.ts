import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type ContactSchemaDocument = HydratedDocument<ContactSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'contacts',
  toJSON: {
    virtuals: true,
    getters: true,
    transform: (doc, ret: any) => {
      ret.version = ret.__v;
      delete ret.__v;
      return ret;
    },
  },
})
export class ContactSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true, index: true })
  firstName: string;

  @Prop({ required: true, index: true })
  lastName: string;

  @Prop({ type: [String], default: [] })
  emails: string[];

  @Prop({ type: [String], default: [] })
  phones: string[];

  @Prop({ index: true })
  lifecycleStageId: string;

  @Prop({ index: true })
  statusId: string;

  @Prop()
  companyName?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'AccountSchemaClass' })
  accountId?: string;

  @Prop()
  title?: string;

  @Prop({ index: true })
  sourceId?: string;

  @Prop()
  role?: string;

  @Prop()
  address?: string;

  @Prop()
  birthday?: Date;

  @Prop({ type: MongooseSchema.Types.Mixed })
  customFields?: Record<string, any>;

  @Prop({ default: 0 })
  score?: number;

  @Prop({ default: false })
  emailOptIn?: boolean;

  @Prop({ default: false })
  smsOptIn?: boolean;

  @Prop({ default: false })
  doNotCall?: boolean;

  @Prop({ type: [String], default: [] })
  tags?: string[];

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  ownerId?: string;

  // Org-unit ownership: the node of the tenant's org tree this record belongs
  // to. Populated at create time from the record owner's org unit; read by the
  // 'org_unit' and 'org_unit_subtree' data scopes.
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

  @Prop({ default: now })
  createdAt: Date;

  @Prop({ default: now })
  updatedAt: Date;

  @Prop({ index: true })
  lastActivityAt?: Date;

  @Prop()
  deletedAt?: Date;

  // ────────────────── OMNI-CHANNEL / SHADOW CONTACT ──────────────────

  /**
   * Multiple omni-channel identities linked to this contact.
   * Each entry represents one social/messaging account
   * (e.g. Facebook PSID, Zalo User ID).
   */
  @Prop({
    type: [
      {
        _id: false,
        channelType: { type: String, required: true },
        senderId: { type: String, required: true },
      },
    ],
    default: [],
  })
  omniIdentities: Array<{ channelType: string; senderId: string }>;

  /** Flag to indicate this is a temporary/anonymous contact created from a chat */
  @Prop({ default: false })
  isShadow: boolean;

  /** Flag to indicate this contact is a VIP customer (priority routing) */
  @Prop({ default: false, index: true })
  isVIP: boolean;

  // ────────────────── STAGE HISTORY TRACKING ──────────────────

  /**
   * Embedded log of all lifecycle stage transitions.
   * Each entry records: from → to, timestamp, who made the change, and optional reason.
   */
  @Prop({
    type: [
      {
        fromStage: { type: String, default: null },
        toStage: { type: String, required: true },
        changedAt: { type: Date, required: true, default: Date.now },
        changedById: {
          type: MongooseSchema.Types.ObjectId,
          ref: 'UserSchemaClass',
        },
        reason: { type: String },
        direction: { type: String, enum: ['forward', 'backward', 'lateral'] },
        skippedStages: { type: [String], default: [] },
      },
    ],
    default: [],
  })
  stageHistory: Array<{
    fromStage: string | null;
    toStage: string;
    changedAt: Date;
    changedById: string;
    reason?: string;
    direction?: 'forward' | 'backward' | 'lateral';
    skippedStages?: string[];
  }>;

  // ──────────────────── SOCIAL PROFILES ────────────────────

  @Prop()
  linkedinUrl?: string;

  @Prop()
  twitterUrl?: string;

  @Prop()
  instagramUrl?: string;

  @Prop()
  tiktokUrl?: string;

  @Prop()
  youtubeUrl?: string;

  @Prop()
  githubUrl?: string;
}

export const ContactSchema = SchemaFactory.createForClass(ContactSchemaClass);

ContactSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
ContactSchema.index({ tenantId: 1, emails: 1 });
ContactSchema.index({ tenantId: 1, firstName: 1, lastName: 1 });
ContactSchema.index(
  { tenantId: 1, createdAt: -1, _id: -1 },
  { name: 'tenant_created_cursor' },
);
// NOTE: the former `omni_identity_lookup` index — keyed on
// `omniIdentities.channelType + senderId` with NO tenantId prefix — was dropped.
// It was strictly redundant with `tenant_omni_identity_lookup` below (every
// lookup goes through applyTenantFilter, so no query ever omitted tenantId) and
// as a cross-tenant multikey index over an array field it was one of the largest
// on the collection. Dropping it removes RAM pressure from the hot inbound path
// at 100M contacts, and removes an index a mis-scoped query could have used.
// Existing deployments: `db.contacts.dropIndex('omni_identity_lookup')`.
ContactSchema.index(
  {
    tenantId: 1,
    'omniIdentities.channelType': 1,
    'omniIdentities.senderId': 1,
  },
  { name: 'tenant_omni_identity_lookup' },
);
ContactSchema.index(
  { tenantId: 1, 'omniIdentities.senderId': 1 },
  { name: 'tenant_omni_sender' },
);
ContactSchema.index(
  { tenantId: 1, 'omniIdentities.senderId': 1, isVIP: 1 },
  { name: 'tenant_sender_vip_lookup' },
);
ContactSchema.index(
  { tenantId: 1, ownerId: 1 },
  { name: 'tenant_owner_lookup', sparse: false },
);
ContactSchema.index(
  { tenantId: 1, isVIP: 1, createdAt: -1 },
  { name: 'tenant_vip_created_lookup' },
);
ContactSchema.index(
  { tenantId: 1, lastActivityAt: 1 },
  { name: 'tenant_last_activity' },
);
ContactSchema.index({ tenantId: 1, score: 1 }, { name: 'tenant_score' });
ContactSchema.index(
  { tenantId: 1, phones: 1 },
  { name: 'tenant_phone_lookup' },
);
// Partial index for the default list view.
//
// The plain `(tenantId, deletedAt, createdAt)` index it replaces could not serve
// the query that actually runs: every read filters `deletedAt: null`, and Mongo
// cannot use an index selectively for a null/missing match — it still walked the
// deleted entries. A partial index contains ONLY live contacts, so it is both
// smaller and fully selective, and the deleted rows (a rounding error by count,
// and now bounded by the 30-day retention purge) simply are not in it.
ContactSchema.index(
  { tenantId: 1, createdAt: -1, _id: -1 },
  {
    name: 'tenant_active_list',
    partialFilterExpression: { deletedAt: null },
  },
);
// The recycle bin: soft-deleted contacts, newest first. Also the driver for
// ContactPurgeService.findPurgeable, which scans by `deletedAt` ascending.
ContactSchema.index(
  { tenantId: 1, deletedAt: -1 },
  {
    name: 'tenant_recycle_bin',
    partialFilterExpression: { deletedAt: { $type: 'date' } },
  },
);
// The owner axis is OR-ed with the org-unit axis in applyTenantFilter, and Mongo
// needs an index per `$or` branch. `tenant_owner_lookup` covered the first
// branch; the second had none, so an org-unit-scoped read fell back to a scan.
ContactSchema.index(
  { tenantId: 1, orgUnitId: 1 },
  { name: 'tenant_org_unit_lookup' },
);
// "Contacts at this company" — the account detail page's related list.
ContactSchema.index(
  { tenantId: 1, accountId: 1 },
  { name: 'tenant_account_lookup' },
);
// Tag filtering from the list view and TagUsageService.countUsage.
ContactSchema.index({ tenantId: 1, tags: 1 }, { name: 'tenant_tag_lookup' });
// Funnel + growth reports group by stage over a date range.
ContactSchema.index(
  { tenantId: 1, lifecycleStageId: 1, createdAt: -1 },
  { name: 'tenant_stage_created' },
);
ContactSchema.index(
  { firstName: 'text', lastName: 'text', emails: 'text' },
  {
    name: 'contact_text_search',
    default_language: 'none',
  },
);

ContactSchema.virtual('owner', {
  ref: 'UserSchemaClass',
  localField: 'ownerId',
  foreignField: '_id',
  justOne: true,
});

ContactSchema.virtual('createdBy', {
  ref: 'UserSchemaClass',
  localField: 'createdById',
  foreignField: '_id',
  justOne: true,
});

ContactSchema.virtual('updatedBy', {
  ref: 'UserSchemaClass',
  localField: 'updatedById',
  foreignField: '_id',
  justOne: true,
});
