import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type OmniMessageDocument = HydratedDocument<OmniMessageSchemaClass>;

const SENDER_TYPES = ['customer', 'agent', 'system'];
const MESSAGE_TYPES = [
  'text',
  'image',
  'file',
  'audio',
  'video',
  'location',
  'sticker',
  'template',
];
const MESSAGE_STATUSES = ['sending', 'sent', 'delivered', 'read', 'failed'];

/**
 * Schema for individual messages within a conversation.
 *
 * Indexed by conversation for efficient paginated retrieval.
 * The `externalMessageId` is used for deduplication from provider webhooks.
 */
@Schema({
  timestamps: true,
  collection: 'omni_messages',
  toJSON: { virtuals: true, getters: true },
})
export class OmniMessageSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'OmniConversationSchemaClass',
    required: true,
    index: true,
  })
  conversationId: string;

  /** External user/agent ID from the provider or our internal user ID */
  @Prop({ required: true })
  senderId: string;

  /** Display name captured at send time for agent/API/bot attribution */
  @Prop()
  senderName: string;

  /** Avatar captured at send time, if available */
  @Prop()
  senderAvatarUrl: string;

  @Prop({ required: true, enum: SENDER_TYPES })
  senderType: string;

  /** Business origin of the outbound message, e.g. agent_ui, crm_api, bot, job, automation */
  @Prop({ type: String, index: true })
  source: string;

  @Prop({ required: true, enum: MESSAGE_TYPES })
  messageType: string;

  @Prop({ default: '' })
  content: string;

  /** Original media URL from the provider (may expire) */
  @Prop()
  mediaUrl: string;

  /** Our proxied/cached media URL (stable, long-lived) */
  @Prop()
  mediaProxyUrl: string;

  @Prop({
    enum: MESSAGE_STATUSES,
    default: 'delivered',
  })
  status: string;

  /** Provider-specific metadata (quick_reply, reaction, etc.) */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  metadata: Record<string, any>;

  /** The provider's message ID for deduplication */
  @Prop()
  externalMessageId: string;

  /**
   * Client-generated idempotency key for outbound agent messages.
   * Retries with the same key must return this same message instead of
   * creating or sending a duplicate provider message.
   */
  @Prop({ type: String, sparse: true })
  idempotencyKey: string;

  /** Optional optimistic UI identifier supplied by the browser. */
  @Prop({ type: String, sparse: true })
  clientMessageId: string;

  /**
   * Canonical platform message ID used as the primary deduplication key.
   * This is the unique ID assigned by the provider (FB mid, Zalo msgId, etc.).
   * A compound unique index on (tenant, platformMessageId) is the final
   * safeguard against duplicate writes.
   */
  @Prop({ type: String, sparse: true })
  platformMessageId: string;

  /**
   * Provider's original message timestamp — the canonical sort key.
   * This ensures messages are displayed in the order the customer
   * actually sent them, regardless of server processing delays.
   */
  @Prop({ type: Date, index: true })
  providerTimestamp: Date;
}

export const OmniMessageSchema = SchemaFactory.createForClass(
  OmniMessageSchemaClass,
);

OmniMessageSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// Retrieve messages for a conversation, sorted by time
OmniMessageSchema.index(
  { conversationId: 1, createdAt: 1 },
  { name: 'conversation_messages' },
);

OmniMessageSchema.index(
  { conversationId: 1, createdAt: 1, _id: 1 },
  { name: 'conversation_messages_created_cursor' },
);

// Deterministic cursor scan per conversation — uses providerTimestamp as primary sort key
// with createdAt and _id as tiebreakers for consistent ordering.
OmniMessageSchema.index(
  { conversationId: 1, providerTimestamp: 1, createdAt: 1, _id: 1 },
  { name: 'conversation_messages_timeline' },
);

// Deduplication: prevent processing the same webhook message twice
// Use partialFilterExpression to only include documents where externalMessageId is a non-null string.
// This allows outbound messages (which start with no external ID) to coexist without conflict.
OmniMessageSchema.index(
  { tenantId: 1, externalMessageId: 1 },
  {
    unique: true,
    name: 'dedup_external_message',
    partialFilterExpression: { externalMessageId: { $type: 'string' } },
  },
);

// Primary deduplication index — compound unique on (tenant, platformMessageId).
// This is the DB-level safeguard ensuring the same platform message is never stored twice.
OmniMessageSchema.index(
  { tenantId: 1, platformMessageId: 1 },
  {
    unique: true,
    name: 'dedup_platform_message',
    partialFilterExpression: { platformMessageId: { $type: 'string' } },
  },
);

// Outbound idempotency: one client-generated key can produce only one message.
OmniMessageSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  {
    unique: true,
    name: 'dedup_outbound_idempotency_key',
    partialFilterExpression: { idempotencyKey: { $type: 'string' } },
  },
);
