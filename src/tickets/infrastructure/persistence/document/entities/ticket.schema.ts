import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type TicketSchemaDocument = HydratedDocument<TicketSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'tickets',
  toJSON: {
    virtuals: true,
    getters: true,
  },
})
export class TicketSchemaClass extends EntityDocumentHelper {
  // ── 1. CORE & TENANT ───────────────────────────────────────────────────
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true, unique: true, index: true })
  ticketNumber: string;

  @Prop({ required: true, index: true })
  subject: string;

  @Prop()
  description?: string;

  // ── 2. CUSTOMER CONTEXT (Ai đang gặp vấn đề?) ────────────────────────
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'ContactSchemaClass',
    index: true,
  })
  contactId?: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'AccountSchemaClass',
    index: true,
  })
  accountId?: string;

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

  // Polymorphic link
  @Prop({ type: MongooseSchema.Types.Mixed })
  relatedTo?: {
    type: string;
    _id: string;
    name: string;
  };

  // ── 3. CLASSIFICATION & ROUTING ────────────────────────────────────────
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TicketTypeSchemaClass',
    required: true,
    index: true,
  })
  typeId: string;

  // N-level category path: array of node IDs from root → leaf
  @Prop({ type: [String], default: undefined })
  categoryPath?: string[];

  @Prop({ required: true, default: 'MEDIUM' })
  priority: string; // URGENT, HIGH, MEDIUM, LOW

  @Prop()
  channel?: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TicketSourceSchemaClass',
    index: true,
  })
  sourceId?: string;

  @Prop({ type: [String], default: [] })
  tags?: string[];

  @Prop({ type: MongooseSchema.Types.Mixed })
  customFields?: Record<string, any>;

  // ── 4. ASSIGNMENT & COLLABORATION ─────────────────────────────────────
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'GroupSchemaClass',
    index: true,
  })
  groupId?: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    index: true,
  })
  ownerId?: string;

  @Prop({
    type: [{ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' }],
  })
  watchers?: string[];

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TicketStatusSchemaClass',
    required: true,
    index: true,
  })
  statusId: string;

  // ── 5. SLA MANAGEMENT ─────────────────────────────────────────────────
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'SlaPolicySchemaClass' })
  slaPolicyId?: string;

  @Prop()
  firstResponseDueAt?: Date;

  @Prop()
  resolutionDueAt?: Date;

  @Prop({ default: false, index: true })
  isSlaBreached: boolean;

  // ── 6. METRICS & RESOLUTION ───────────────────────────────────────────
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TicketResolutionCodeSchemaClass',
  })
  resolutionCodeId?: string;

  @Prop()
  resolutionNotes?: string;

  @Prop({ min: 1, max: 5 })
  csatScore?: number;

  @Prop({ default: 0 })
  timeSpentSeconds?: number;

  // ── 7. TIMESTAMPS & AUDIT ─────────────────────────────────────────────
  @Prop()
  firstRespondedAt?: Date;

  @Prop()
  resolvedAt?: Date;

  @Prop()
  closedAt?: Date;

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

  @Prop()
  deletedAt?: Date;
}

export const TicketSchema = SchemaFactory.createForClass(TicketSchemaClass);

TicketSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// ── Compound Indexes ─────────────────────────────────────────────────────
TicketSchema.index({ tenantId: 1, ticketNumber: 1 });
TicketSchema.index({ tenantId: 1, statusId: 1 });
TicketSchema.index(
  { tenantId: 1, ownerId: 1 },
  { name: 'tenant_owner_lookup' },
);
TicketSchema.index(
  { tenantId: 1, contactId: 1 },
  { name: 'tenant_contact_lookup' },
);
TicketSchema.index(
  { tenantId: 1, accountId: 1 },
  { name: 'tenant_account_lookup' },
);
TicketSchema.index(
  { tenantId: 1, groupId: 1 },
  { name: 'tenant_group_lookup' },
);
TicketSchema.index({ tenantId: 1, typeId: 1 }, { name: 'tenant_type_lookup' });
TicketSchema.index(
  { tenantId: 1, isSlaBreached: 1 },
  { name: 'tenant_sla_breached' },
);
TicketSchema.index(
  { omniConversationId: 1 },
  { name: 'ticket_omni_conversation' },
);

// ── Virtuals ─────────────────────────────────────────────────────────────
TicketSchema.virtual('contact', {
  ref: 'ContactSchemaClass',
  localField: 'contactId',
  foreignField: '_id',
  justOne: true,
});

TicketSchema.virtual('account', {
  ref: 'AccountSchemaClass',
  localField: 'accountId',
  foreignField: '_id',
  justOne: true,
});

TicketSchema.virtual('owner', {
  ref: 'UserSchemaClass',
  localField: 'ownerId',
  foreignField: '_id',
  justOne: true,
});

TicketSchema.virtual('group', {
  ref: 'GroupSchemaClass',
  localField: 'groupId',
  foreignField: '_id',
  justOne: true,
});

TicketSchema.virtual('slaPolicy', {
  ref: 'SlaPolicySchemaClass',
  localField: 'slaPolicyId',
  foreignField: '_id',
  justOne: true,
});

TicketSchema.virtual('ticketStatus', {
  ref: 'TicketStatusSchemaClass',
  localField: 'statusId',
  foreignField: '_id',
  justOne: true,
});

TicketSchema.virtual('ticketType', {
  ref: 'TicketTypeSchemaClass',
  localField: 'typeId',
  foreignField: '_id',
  justOne: true,
});

TicketSchema.virtual('ticketSource', {
  ref: 'TicketSourceSchemaClass',
  localField: 'sourceId',
  foreignField: '_id',
  justOne: true,
});

TicketSchema.virtual('ticketResolution', {
  ref: 'TicketResolutionCodeSchemaClass',
  localField: 'resolutionCodeId',
  foreignField: '_id',
  justOne: true,
});
