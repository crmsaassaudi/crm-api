import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type OmniConversationDocument =
  HydratedDocument<OmniConversationSchemaClass>;

const CONVERSATION_STATUSES = ['open', 'pending', 'resolved', 'closed'];
const CHANNEL_TYPES = [
  'Facebook',
  'Zalo',
  'WhatsApp',
  'LiveChat',
  'Instagram',
  'TikTok',
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

  @Prop({ required: true, enum: CHANNEL_TYPES })
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
    required: true,
    enum: CONVERSATION_STATUSES,
    default: 'open',
    index: true,
  })
  status: string;

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

  // ── SLA Tracking ───────────────────────────────────────────────

  /** The SLA policy applied to this conversation */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'SlaPolicySchemaClass',
    default: null,
  })
  slaPolicyId: string | null;

  /** Deadline for the first response (computed from SLA policy targets) */
  @Prop({ type: Date, default: null, index: true })
  slaDeadline: Date | null;

  /** Whether the SLA has been breached (deadline passed without response) */
  @Prop({ default: false })
  slaBreached: boolean;
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
