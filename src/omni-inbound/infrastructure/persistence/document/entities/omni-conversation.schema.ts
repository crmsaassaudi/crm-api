import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';
import { SUPPORTED_CHANNELS } from '../../../../domain/channel-capabilities';

export type OmniConversationDocument =
  HydratedDocument<OmniConversationSchemaClass>;

const CONVERSATION_STATUSES = ['open', 'pending', 'resolved', 'closed'];
const BOT_STATUSES = ['active', 'handoff', 'ended'];

/**
 * Schema for omni-channel conversations (chat sessions).
 *
 * A single customer can have MULTIPLE conversations over time.
 * A resolved conversation may reopen inside the configured reopen window.
 * A closed conversation is terminal; later inbound traffic creates a new
 * linked support session.
 */
@Schema({
  timestamps: true,
  collection: 'omni_conversations',
  toJSON: { virtuals: true, getters: true },
})
export class OmniConversationSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'ChannelSchemaClass',
    required: true,
    index: true,
  })
  channelId: string;

  /** Immutable inbox ownership snapshot selected when the session is created. */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'InboxSchemaClass',
    default: null,
    index: true,
  })
  inboxId: string | null;

  @Prop({ required: true, index: true })
  channelAccount: string;

  /**
   * Which channel this conversation arrived on.
   *
   * The enum is the capability registry, not a second hand-maintained list. The
   * two had already drifted: `telegram` was a fully implemented channel with a
   * working adapter that this enum would have rejected on write, so even once its
   * inbound event was connected the conversation could not have been created.
   */
  @Prop({
    type: String,
    required: true,
    enum: SUPPORTED_CHANNELS,
  })
  channelType: string;

  /**
   * The unique provider identifier for this thread.
   * e.g. "psid_pageid" for Facebook, "zaloUserId_oaId" for Zalo.
   * Used to match incoming messages to the correct conversation.
   */
  @Prop({ required: true, index: true })
  externalId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'ContactSchemaClass',
    index: true,
    default: null,
  })
  contactId: string | null;

  /** Cached customer info from the webhook platforms */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  customer: {
    externalId: string;
    name: string;
    avatarUrl?: string;
    phone?: string;
    email?: string;
  };

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    default: null,
  })
  assignedAgentId: string | null;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'GroupSchemaClass',
    default: null,
    index: true,
  })
  assignedGroupId: string | null;

  // Org-unit ownership: the node of the tenant's org tree this record belongs
  // to. Populated at create time from the record owner's org unit; read by the
  // 'org_unit' and 'org_unit_subtree' data scopes.
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null, index: true })
  orgUnitId?: string | null;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    default: null,
  })
  claimedById: string | null;

  @Prop({ type: Date, default: null })
  claimedAt: Date | null;

  /**
   * Session management state:
   * - 'open': active conversation, accepting messages
   * - 'pending': waiting for agent assignment
   * - 'resolved': agent has closed this session
   * - 'closed': permanently archived
   */
  @Prop({
    type: String,
    required: true,
    enum: CONVERSATION_STATUSES,
    default: 'open',
    index: true,
  })
  status: string;

  /**
   * Bot runtime state.
   *
   * Keep this object default-free in the schema. New records should receive
   * application-level values from the conversation creation flow so old data is
   * never silently backfilled with misleading runtime defaults.
   */
  @Prop({
    type: {
      enabled: { type: Boolean },
      provider: { type: String },
      flowId: { type: String },
      sessionId: { type: String },
      status: { type: String, enum: BOT_STATUSES },
      lastError: { type: String },
      handoffReason: { type: String },
      handoffMessage: { type: String },
      handoffTarget: {
        type: String,
        enum: ['general', 'group', 'agent'],
      },
      handoffTargetId: { type: String },
      handedOffAt: { type: Date },
      handedOffByInboundMessageId: { type: String },
    },
    _id: false,
  })
  bot?: {
    enabled: boolean;
    provider: string;
    flowId?: string | null;
    sessionId?: string | null;
    status: 'active' | 'handoff' | 'ended';
    lastError?: string | null;
    handoffReason?: string | null;
    handoffMessage?: string | null;
    handoffTarget?: 'general' | 'group' | 'agent' | null;
    handoffTargetId?: string | null;
    handedOffAt?: Date | null;
    handedOffByInboundMessageId?: string | null;
  };

  @Prop({ default: '' })
  lastMessage: string;

  @Prop({ type: Date, default: null, index: true })
  lastMessageAt: Date | null;

  // Aggregate Fields (Phase 1)

  /** Monotonically increasing sequence counter for causal ordering.
   *  Allocated atomically via $inc inside ConversationOpsProcessor. */
  @Prop({ default: 0 })
  nextSequence: number;

  /**
   * Sequence of the message the `lastMessage*` fields describe.
   *
   * Guards the preview against being rewound by a message that is replayed or
   * delivered late: the summary only moves forward.
   */
  @Prop({ default: 0 })
  lastMessageSequence: number;

  /** Reference to the most recent message document. */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'OmniMessageSchemaClass',
    default: null,
  })
  lastMessageId: string | null;

  /** Truncated content preview (max 200 chars) for conversation list rendering. */
  @Prop({ type: String, default: null })
  lastMessagePreview: string | null;

  /** Message type of the last message (text, image, file, etc.). */
  @Prop({ type: String, default: null })
  lastMessageType: string | null;

  /** Sender type of the last message (customer, agent, bot). */
  @Prop({ type: String, default: null })
  lastMessageSenderType: string | null;

  @Prop({ default: 0 })
  unreadCount: number;

  @Prop({ type: [String], default: [] })
  tags: string[];

  /**
   * Whether the customer behind this conversation is a VIP.
   *
   * Denormalised from `contacts.isVIP` deliberately. Two things read it and both
   * need it on this document:
   *
   *  - the inbox filter, which cannot join to `contacts` inside a paginated,
   *    scope-filtered list query;
   *  - `buildRoutingContext`, which sets `segment: 'VIP'` for the assignment
   *    engine on the inbound hot path, where an extra lookup per message is a
   *    cost paid on every message rather than on every VIP.
   *
   * Both read it as `conversation.isVip` and, before this field existed, both
   * read `undefined`: the filter always returned nothing and the VIP segment was
   * never set, so any assignment rule keyed on it could never fire. It is kept
   * in step by ContactsService when the flag changes and set when a conversation
   * is created or linked to a contact.
   *
   * Deliberately NOT indexed on its own. A boolean has two values, so an index
   * on it alone is nearly the size of the collection and selective for neither;
   * the VIP filter always arrives with a status filter and a `lastMessageAt`
   * sort, which `conversation_list` already serves with `isVip` applied as a
   * residual predicate. A dedicated compound index belongs here only if the
   * measured plan says so — not in advance, and not on the hottest collection in
   * the system.
   */
  @Prop({ type: Boolean, default: false })
  isVip: boolean;

  @Prop({ default: 0 })
  messageCount: number;

  // Reopen tracking
  @Prop({ default: 0 })
  reopenCount: number;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'OmniConversationSchemaClass',
    default: null,
  })
  previousConversationId: string | null;

  // Close / Resolve metadata
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    default: null,
  })
  resolvedByAgentId: string | null;

  @Prop({ type: Date, default: null })
  resolvedAt: Date | null;

  @Prop({
    type: String,
    enum: [
      'resolved_by_agent',
      'auto_resolved',
      'customer_left',
      'bot_resolved',
      'system_resolved',
      'other',
      null,
    ],
    default: null,
  })
  resolveReason: string | null;

  /** Optional note written by the agent when resolving the conversation */
  @Prop({ type: String, default: null })
  resolveNote: string | null;

  /**
   * Who or what triggered the resolution:
   * - 'agent'  — manually resolved by a human agent
   * - 'auto'   — auto-resolved by inactivity timer
   * - 'bot'    — resolved by a chatbot/automation
   * - 'system' — resolved by a system process (import, migration, etc.)
   */
  @Prop({
    type: String,
    enum: ['agent', 'auto', 'bot', 'system', null],
    default: null,
  })
  resolveSource: string | null;

  // Handling timeline
  //
  // The four facts every contact-centre metric is derived from. Before these
  // existed the module could say a conversation had *breached* its first-response
  // SLA but never when — or whether — anyone actually answered, so First Response
  // Time, time-to-assign and handling time were all uncomputable.
  //
  // `omni_sla_clocks` is the authority on SLA state; these are the raw business
  // events, recorded whether or not a policy happens to be configured.

  /**
   * When an agent (not a bot, not the system) first replied.
   *
   * Written exactly once, by a conditional update that requires the field to
   * still be null — the reply path is concurrent, and "first" has to mean first.
   */
  @Prop({ type: Date, default: null })
  firstRespondedAt: Date | null;

  /**
   * Who sent that first reply.
   *
   * Agent performance is credited to this, not to `assignedAgentId`: a transfer
   * changes the assignee, and reporting on the assignee moved the whole
   * conversation's handling time and SLA outcome onto whoever happened to hold it
   * at resolution time.
   */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    default: null,
    index: true,
  })
  firstResponderId: string | null;

  /**
   * When this conversation started waiting for an owner: at creation while
   * unassigned, and again each time it returns to the queue (offer declined or
   * lapsed, agent unassigned). Cleared on assignment.
   *
   * Live wait = now − queuedAt. Completed wait = assignedAt − queuedAt.
   */
  @Prop({ type: Date, default: null })
  queuedAt: Date | null;

  /** When an agent most recently took ownership. */
  @Prop({ type: Date, default: null })
  assignedAt: Date | null;

  /**
   * Cumulative time spent unowned, in milliseconds — the honest answer to "how
   * long did this customer wait?" across re-offers, accumulated on each
   * assignment so it survives a queue → agent → queue → agent path.
   */
  @Prop({ type: Number, default: 0 })
  totalQueuedMs: number;

  // SLA projection
  //
  // Denormalised from `omni_sla_clocks` so the inbox list — a paginated,
  // scope-filtered query on the hottest collection in the system — can filter and
  // sort on SLA without joining. The clocks remain authoritative; these are a
  // read model with exactly one writer (SlaClockService.projectOntoConversation).

  /** Earliest deadline among still-running clocks; null when none are running. */
  @Prop({ type: Date, default: null })
  slaDueAt: Date | null;

  /** Which metric `slaDueAt` belongs to — drives the timer label in the inbox. */
  @Prop({
    type: String,
    enum: ['first_response', 'next_response', 'resolution', null],
    default: null,
  })
  slaDueMetric: string | null;

  /** True once any clock on this conversation has breached. */
  @Prop({ type: Boolean, default: false })
  slaBreached: boolean;

  @Prop({ type: Date, default: null })
  slaBreachedAt: Date | null;

  // Escalation Tracking
  /**
   * Current escalation level for this conversation:
   * - null: no escalation
   * - 'warning': visual warning (red highlight)
   * - 'critical': manager notified
   */
  @Prop({
    type: String,
    enum: ['warning', 'critical', null],
    default: null,
  })
  escalationLevel: string | null;

  /** ID of the manager/supervisor who was notified during escalation */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    default: null,
  })
  escalatedToId: string | null;

  /** When the escalation was triggered */
  @Prop({ type: Date, default: null })
  escalatedAt: Date | null;

  // Platform Reply Window
  /**
   * Timestamp of the customer's most recent inbound message.
   * Used to calculate the platform reply window (e.g. 24h for Facebook).
   * Agent free-form replies are only allowed within the window.
   */
  @Prop({ type: Date, default: null, index: true })
  lastCustomerMessageAt: Date | null;

  /**
   * When the conversation should automatically reopen after being snoozed.
   * Null when the conversation is not snoozed.
   */
  @Prop({ type: Date, default: null })
  snoozeUntil: Date | null;

  // CSAT (Customer Satisfaction)

  /**
   * Satisfaction score submitted by the customer (1 = terrible, 5 = excellent).
   * null = survey not yet submitted or not sent.
   */
  @Prop({ type: Number, min: 1, max: 5, default: null })
  csatScore: number | null;

  /** Optional free-text comment from the customer with the CSAT survey */
  @Prop({ type: String, default: null })
  csatComment: string | null;

  /** When the customer submitted the CSAT survey */
  @Prop({ type: Date, default: null })
  csatSubmittedAt: Date | null;

  /**
   * One-time token included in the survey link.
   * Used to authenticate the public CSAT submission endpoint
   * without requiring the customer to log in.
   */
  @Prop({ type: String, default: null, index: true, sparse: true })
  csatToken: string | null;

  /**
   * When the survey link stops working.
   *
   * The token had no expiry, which made it a permanent unauthenticated write
   * handle to a conversation's satisfaction score — anyone who kept the link (or
   * found it in a forwarded chat) could set it months later. A survey is also only
   * meaningful while the interaction is remembered.
   */
  @Prop({ type: Date, default: null })
  csatTokenExpiresAt: Date | null;
}

export const OmniConversationSchema = SchemaFactory.createForClass(
  OmniConversationSchemaClass,
);

OmniConversationSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// Partial unique index: ensure only ONE active (open or pending) session exists per customer thread identifiers.
OmniConversationSchema.index(
  { tenantId: 1, channelType: 1, channelAccount: 1, externalId: 1 },
  {
    unique: true,
    name: 'unique_active_session',
    partialFilterExpression: { status: { $in: ['open', 'pending'] } },
  },
);

// List conversations sorted by last activity
OmniConversationSchema.index(
  { tenantId: 1, status: 1, lastMessageAt: -1 },
  { name: 'conversation_list' },
);

OmniConversationSchema.index(
  { tenantId: 1, inboxId: 1, status: 1, lastMessageAt: -1, _id: -1 },
  { name: 'conversation_inbox_queue' },
);

// "Unanswered" filter — conversations whose last message is still from the
// customer (agent hasn't replied), sorted newest or oldest first.
OmniConversationSchema.index(
  { tenantId: 1, status: 1, lastMessageSenderType: 1, lastMessageAt: -1 },
  { name: 'conversation_unanswered' },
);

// Agent load checks for assignment and fallback.
OmniConversationSchema.index(
  { tenantId: 1, assignedAgentId: 1, status: 1 },
  { name: 'agent_open_load' },
);

// SLA filters in the inbox: "breached" and "due within N minutes". One index
// serves both — `slaBreached` is the equality prefix, `slaDueAt` the range.
OmniConversationSchema.index(
  { tenantId: 1, slaBreached: 1, slaDueAt: 1 },
  { name: 'conversation_sla' },
);

// Supervisor queue console: unowned conversations, longest wait first. Partial so
// the index holds only what is actually in a queue — a few rows, not the
// collection.
OmniConversationSchema.index(
  { tenantId: 1, assignedGroupId: 1, queuedAt: 1 },
  {
    name: 'conversation_queue_wait',
    partialFilterExpression: { queuedAt: { $type: 'date' } },
  },
);

// Sticky routing lookup by linked contact.
OmniConversationSchema.index(
  { tenantId: 1, contactId: 1, status: 1, resolvedAt: -1, updatedAt: -1 },
  { name: 'sticky_by_contact' },
);

// Sticky routing fallback lookup by platform sender id.
OmniConversationSchema.index(
  {
    tenantId: 1,
    'customer.externalId': 1,
    status: 1,
    resolvedAt: -1,
    updatedAt: -1,
  },
  { name: 'sticky_by_sender' },
);

// Customer name only — deliberately NOT `lastMessage`.
//
// `lastMessage` is rewritten on every inbound and outbound message, so
// including it made this text index the most-updated index in the system, on
// its hottest collection. It also made the results inconsistent: it matched
// only whatever the newest message happened to be, so a thread dropped out of
// its own search result as soon as the customer said something else.
// Full-text search over message bodies belongs in OpenSearch, which indexes
// every message rather than the last one.
OmniConversationSchema.index(
  { tenantId: 1, 'customer.name': 'text' },
  { name: 'conversation_text_search' },
);

// Thread timeline scan: deterministic ordering by createdAt + _id.
OmniConversationSchema.index(
  {
    tenantId: 1,
    channelType: 1,
    channelAccount: 1,
    externalId: 1,
    createdAt: 1,
    _id: 1,
  },
  { name: 'conversation_thread_timeline' },
);

OmniConversationSchema.virtual('assignedAgent', {
  ref: 'UserSchemaClass',
  localField: 'assignedAgentId',
  foreignField: '_id',
  justOne: true,
});

OmniConversationSchema.virtual('resolvedByAgent', {
  ref: 'UserSchemaClass',
  localField: 'resolvedByAgentId',
  foreignField: '_id',
  justOne: true,
});
