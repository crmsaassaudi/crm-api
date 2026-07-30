import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type DeliveryCommandDocument =
  HydratedDocument<DeliveryCommandSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'omni_delivery_commands',
  toJSON: { virtuals: true, getters: true },
})
export class DeliveryCommandSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
  })
  tenantId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'OmniMessageSchemaClass',
    required: true,
  })
  messageId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'OmniConversationSchemaClass',
    required: true,
  })
  conversationId: string;

  @Prop({ type: String, required: true })
  agentId: string;

  @Prop({ type: String, required: true })
  content: string;

  @Prop({ type: String, required: true })
  messageType: string;

  @Prop({
    type: String,
    enum: ['text', 'template', 'interactive', 'carousel', 'media', 'email'],
    required: true,
    default: 'text',
  })
  kind: 'text' | 'template' | 'interactive' | 'carousel' | 'media' | 'email';

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  payload: Record<string, any>;

  @Prop({ type: String, required: true })
  source: string;

  @Prop({ type: String, enum: ['http', 'socket'], required: true })
  transport: 'http' | 'socket';

  @Prop({ type: String, default: null })
  idempotencyKey?: string | null;

  @Prop({ type: String, default: null })
  clientMessageId?: string | null;

  @Prop({
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'unknown'],
    required: true,
    default: 'pending',
  })
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'unknown';

  @Prop({ type: Date, default: null })
  processingStartedAt?: Date | null;

  @Prop({ type: Date, default: null })
  completedAt?: Date | null;

  @Prop({ type: String, default: null })
  externalMessageId?: string | null;

  @Prop({ type: String, default: null })
  lastError?: string | null;
}

export const DeliveryCommandSchema = SchemaFactory.createForClass(
  DeliveryCommandSchemaClass,
);
DeliveryCommandSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
DeliveryCommandSchema.index(
  { tenantId: 1, messageId: 1 },
  { unique: true, name: 'delivery_command_message_unique' },
);
DeliveryCommandSchema.index(
  { status: 1, updatedAt: 1, _id: 1 },
  { name: 'delivery_command_recovery' },
);
