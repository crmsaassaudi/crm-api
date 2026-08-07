import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';
import { searchKeysPlugin } from '../../../../../common/search/search-keys.plugin';

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
  // 1. CORE & TENANT
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true })
  ticketNumber: string;

  @Prop({ required: true, index: true })
  subject: string;

  @Prop()
  description?: string;

  // 2. CUSTOMER CONTEXT (Ai đang gặp vấn đề?)
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'ContactSchemaClass',
    index: true,
  })
  contactId?: string;

  /**
   * The linked Deal.
   *
   * Declared here because `TicketsService.linkDeal` has always written it and Mongoose
   * runs in strict mode by default — so every link was silently DROPPED at the driver
   * boundary. `POST /tickets/:id/link-deal` returned 200 with a ticket that had no
   * `dealId`, and `GET /tickets/by-deal/:dealId` (whose filter was also ignored) then
   * answered with every ticket in the tenant, which read as "the link worked".
   */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'DealSchemaClass',
    index: true,
  })
  dealId?: string | null;

  /**
   * The parent ticket, for the parent/child hierarchy.
   *
   * Missing here for the same reason `dealId` was: `setParent` / `removeParent` /
   * `getChildren` shipped with a service method, a route, an ACL rule and a log line,
   * and strict mode dropped the field on every write — so the parent never persisted and
   * `getChildren` (whose filter was also ignored) answered with the first 100 tickets in
   * the tenant. Three layers of a feature, none of them connected.
   */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TicketSchemaClass',
    index: true,
  })
  parentTicketId?: string | null;

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

  // 3. CLASSIFICATION & ROUTING
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

  // 4. ASSIGNMENT & COLLABORATION
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

  /**
   * Whether a human picked the owner, as opposed to the repository defaulting
   * it to whoever created the record.
   *
   * This is what the assignment engine reads. Both of its gates —
   * `RecordAutoAssignmentListener` skipping already-assigned work, and
   * `RecordCommitPort`'s claim-only CAS — treat a present `ownerId` as
   * deliberate, and every insert is stamped with its creator. Without the flag,
   * no ticket is ever routable.
   */
  @Prop({ default: false, index: true })
  ownerAssignedExplicitly: boolean;

  // Org-unit ownership: the node of the tenant's org tree this record belongs
  // to. Populated at create time from the record owner's org unit; read by the
  // 'org_unit' and 'org_unit_subtree' data scopes.
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null, index: true })
  orgUnitId?: string | null;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TicketStatusSchemaClass',
    required: true,
    index: true,
  })
  statusId: string;

  // 5. SLA MANAGEMENT
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'SlaPolicySchemaClass' })
  slaPolicyId?: string;

  @Prop()
  firstResponseDueAt?: Date;

  @Prop()
  resolutionDueAt?: Date;

  @Prop({ default: false, index: true })
  isSlaBreached: boolean;

  /** Set when SLA timer is manually paused (e.g., waiting for customer) */
  @Prop()
  slaPausedAt?: Date;

  /** Set when SLA is resumed after being paused */
  @Prop()
  slaResumedAt?: Date;

  /** Cumulative seconds the SLA has been on pause (used by breach calculator) */
  @Prop({ default: 0 })
  slaPausedSeconds?: number;

  // ESCALATION
  //
  // Projected by EscalationProcessor when a policy fires on a breached ticket
  // clock — the record that a supervisor has been pulled in.

  @Prop({ type: String, enum: ['warning', 'critical', null], default: null })
  escalationLevel?: 'warning' | 'critical' | null;

  @Prop()
  escalatedAt?: Date;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  escalatedToId?: string | null;

  // 6. METRICS & RESOLUTION
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TicketResolutionCodeSchemaClass',
  })
  resolutionCodeId?: string;

  @Prop()
  resolutionNotes?: string;

  // CSAT — written only by TicketCsatService, off a single-use survey token.

  @Prop({ min: 1, max: 5 })
  csatScore?: number;

  @Prop()
  csatComment?: string;

  @Prop()
  csatSubmittedAt?: Date;

  /** Single-use survey handle. Indexed sparsely — most tickets never hold one. */
  @Prop({ type: String, default: null, index: { sparse: true, unique: true } })
  csatToken?: string | null;

  @Prop()
  csatTokenExpiresAt?: Date;

  // 7. TIMESTAMPS & AUDIT

  /** When an agent first posted a public reply. Written by TicketMessagesService. */
  @Prop()
  firstRespondedAt?: Date;

  /** The agent who owed and gave that first response. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  firstRespondedById?: string | null;

  @Prop()
  resolvedAt?: Date;

  @Prop()
  closedAt?: Date;

  /**
   * How many times this ticket came back after reaching a terminal status.
   *
   * Reopen Rate is one of the four service-quality numbers a support manager
   * is measured on, and it was not derivable from anything the ticket stored.
   */
  @Prop({ default: 0 })
  reopenCount: number;

  @Prop()
  reopenedAt?: Date;

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

// Free-text search.
//
// `relatedTo.name` is the fix for the single most-used missing lookup in the
// product: a support agent could not type a customer's name and see that
// customer's tickets. The value was already on the document and already in the
// OpenSearch projection; only the MongoDB path could not read it.
TicketSchema.plugin(searchKeysPlugin, {
  fields: [
    'subject',
    'ticketNumber',
    'description',
    'relatedTo.name',
    'tags',
    'customFields',
  ],
});

// Compound Indexes
TicketSchema.index(
  { tenantId: 1, ticketNumber: 1 },
  { unique: true, name: 'tenant_ticket_number_unique' },
);
TicketSchema.index({ tenantId: 1, statusId: 1 });
// `closedAt` is part of the key because the hottest owner query is not "what
// does this agent own" but "how much OPEN work does this agent hold" — the
// capacity count the assignment engine runs on every routing decision.
TicketSchema.index(
  { tenantId: 1, ownerId: 1, closedAt: 1 },
  { name: 'tenant_owner_open_work' },
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
  { tenantId: 1, createdAt: -1, _id: -1 },
  { name: 'tenant_created_cursor' },
);
// List sorts, one per field in SORTABLE_FIELDS.Ticket. `ticketNumber` already
// has a unique index but without the `_id` tie-breaker the sort resolver adds,
// so it gets its own; the unique constraint is what that one is for.
TicketSchema.index(
  { tenantId: 1, updatedAt: -1, _id: -1 },
  { name: 'tenant_updated_sort' },
);
TicketSchema.index(
  { tenantId: 1, ticketNumber: -1, _id: -1 },
  { name: 'tenant_ticket_number_sort' },
);
TicketSchema.index(
  { omniConversationId: 1 },
  { name: 'ticket_omni_conversation' },
);
TicketSchema.index(
  { tenantId: 1, firstResponseDueAt: 1, isSlaBreached: 1 },
  { name: 'tenant_first_response_due_sla' },
);
TicketSchema.index(
  { tenantId: 1, resolutionDueAt: 1, isSlaBreached: 1 },
  { name: 'tenant_resolution_due_sla' },
);
TicketSchema.index(
  { tenantId: 1, statusId: 1, createdAt: -1 },
  { name: 'tenant_status_created_lookup' },
);
TicketSchema.index(
  { tenantId: 1, dealId: 1, createdAt: -1 },
  { name: 'tenant_deal_created_lookup' },
);
TicketSchema.index(
  { tenantId: 1, parentTicketId: 1, createdAt: -1 },
  { name: 'tenant_parent_created_lookup' },
);
TicketSchema.index(
  { tenantId: 1, deletedAt: -1 },
  { name: 'tenant_recycle_bin' },
);

// Virtuals
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
