import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type OmniConversationDocument =
  HydratedDocument<OmniConversationSchemaClass>;

const CONVERSATION_STATUSES = ['open', 'pending', 'resolved', 'closed'];
const BOT_STATUSES = ['active', 'handoff', 'ended'];
const CHANNEL_TYPES = [
  'facebook',
  'zalo',
  'whatsapp',
  'livechat',
  'instagram',
  'tiktok',
  'email',
];

/**
 * Schema for omni-channel conversations (chat sessions).
 *
 * A single customer can have MULTIPLE conversations over time.
 * When an agent resolves a conversation, the status moves to 'resolved'.
 * If the customer messages again, a NEW conversation is created.
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

  @Prop({ required: true, index: true })
  channelAccount: string;

  @Prop({
    type: String,
    required: true,
    enum: CHANNEL_TYPES,
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
      lockedAt: { type: Date },
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
    lockedAt?: Date | null;
  };

  @Prop({ default: '' })
  lastMessage: string;

  @Prop({ type: Date, default: null, index: true })
  lastMessageAt: Date | null;

  @Prop({ default: 0 })
  unreadCount: number;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ default: 0 })
  messageCount: number;

  // ── Reopen tracking ────────────────────────────────────────────
  @Prop({ default: 0 })
  reopenCount: number;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'OmniConversationSchemaClass',
    default: null,
  })
  previousConversationId: string | null;

  // ── Close / Resolve metadata ───────────────────────────────────
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

  // ── SLA Tracking: First Response Time (FRT) ─────────────────────
  /** The SLA policy applied for first response */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'SlaPolicySchemaClass',
    default: null,
  })
  frtPolicyId: string | null;

  /** Deadline for the agent's first response */
  @Prop({ type: Date, default: null, index: true })
  frtDeadline: Date | null;

  /** Whether the FRT SLA has been breached */
  @Prop({ default: false })
  frtBreached: boolean;

  // ── SLA Tracking: Resolution Time ──────────────────────────────
  /** The SLA policy applied for resolution */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'SlaPolicySchemaClass',
    default: null,
  })
  resolutionPolicyId: string | null;

  /** Deadline for resolving the conversation */
  @Prop({ type: Date, default: null, index: true })
  resolutionDeadline: Date | null;

  /** Whether the resolution SLA has been breached */
  @Prop({ default: false })
  resolutionBreached: boolean;

  // ── Escalation Tracking ────────────────────────────────────────
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

  // ── Platform Reply Window ──────────────────────────────────────
  /**
   * Timestamp of the customer's most recent inbound message.
   * Used to calculate the platform reply window (e.g. 24h for Facebook).
   * Agent free-form replies are only allowed within the window.
   */
  @Prop({ type: Date, default: null, index: true })
  lastCustomerMessageAt: Date | null;
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

// Agent load checks for assignment and fallback.
OmniConversationSchema.index(
  { tenantId: 1, assignedAgentId: 1, status: 1 },
  { name: 'agent_open_load' },
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

OmniConversationSchema.index(
  { tenantId: 1, 'customer.name': 'text', lastMessage: 'text' },
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
