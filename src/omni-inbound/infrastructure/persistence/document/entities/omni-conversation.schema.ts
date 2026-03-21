import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type OmniConversationDocument = HydratedDocument<OmniConversationSchemaClass>;

const CONVERSATION_STATUSES = ['open', 'pending', 'resolved', 'closed'];
const CHANNEL_TYPES = ['Facebook', 'Zalo', 'WhatsApp', 'LiveChat', 'Instagram', 'TikTok'];

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
    type: String,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenant: string;

  @Prop({
    type: String,
    ref: 'ChannelSchemaClass',
    required: true,
    index: true,
  })
  channel: string;

  @Prop({ required: true, enum: CHANNEL_TYPES })
  channelType: string;

  /**
   * The unique provider identifier for this thread.
   * e.g. "psid_pageid" for Facebook, "zaloUserId_oaId" for Zalo.
   * Used to match incoming messages to the correct conversation.
   */
  @Prop({ required: true, index: true })
  externalId: string;

  /** Cached customer info from the webhook contacts */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  customer: {
    externalId: string;
    name: string;
    avatarUrl?: string;
    phone?: string;
    email?: string;
  };

  @Prop({ type: String, ref: 'UserSchemaClass', default: null })
  assignedAgent: string | null;

  @Prop({ type: String, ref: 'UserSchemaClass', default: null })
  claimedBy: string | null;

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
}

export const OmniConversationSchema = SchemaFactory.createForClass(
  OmniConversationSchemaClass,
);

OmniConversationSchema.plugin(tenantFilterPlugin, { field: 'tenant' });

// Partial unique index: ensure only ONE active (open or pending) session exists per customer thread identifiers.
OmniConversationSchema.index(
  { tenant: 1, channel: 1, externalId: 1 },
  { 
    unique: true, 
    name: 'unique_active_session',
    partialFilterExpression: { status: { $in: ['open', 'pending'] } }
  },
);

// List conversations sorted by last activity
OmniConversationSchema.index(
  { tenant: 1, status: 1, lastMessageAt: -1 },
  { name: 'conversation_list' },
);
