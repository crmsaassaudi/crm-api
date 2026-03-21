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
    type: String,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenant: string;

  @Prop({
    type: String,
    ref: 'OmniConversationSchemaClass',
    required: true,
    index: true,
  })
  conversation: string;

  /** External user/agent ID from the provider or our internal user ID */
  @Prop({ required: true })
  senderId: string;

  @Prop({ required: true, enum: SENDER_TYPES })
  senderType: string;

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
  @Prop({ index: true })
  externalMessageId: string;
}

export const OmniMessageSchema = SchemaFactory.createForClass(
  OmniMessageSchemaClass,
);

OmniMessageSchema.plugin(tenantFilterPlugin, { field: 'tenant' });

// Retrieve messages for a conversation, sorted by time
OmniMessageSchema.index(
  { conversation: 1, createdAt: 1 },
  { name: 'conversation_messages' },
);

// Deduplication: prevent processing the same webhook message twice
OmniMessageSchema.index(
  { tenant: 1, externalMessageId: 1 },
  { unique: true, sparse: true, name: 'dedup_external_message' },
);
