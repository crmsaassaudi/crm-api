import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type DeliveryAttemptDocument =
  HydratedDocument<DeliveryAttemptSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'omni_delivery_attempts',
  toJSON: { virtuals: true, getters: true },
})
export class DeliveryAttemptSchemaClass extends EntityDocumentHelper {
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

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'ChannelSchemaClass',
    required: true,
  })
  channelId: string;

  @Prop({ type: String, required: true })
  channelType: string;

  @Prop({ type: String, required: true, unique: true })
  attemptId: string;

  @Prop({
    type: String,
    enum: ['started', 'succeeded', 'failed', 'unknown'],
    required: true,
    default: 'started',
  })
  status: 'started' | 'succeeded' | 'failed' | 'unknown';

  @Prop({ type: Date, required: true })
  startedAt: Date;

  @Prop({ type: Date, default: null })
  completedAt?: Date | null;

  @Prop({ type: String, default: null })
  externalMessageId?: string | null;

  @Prop({ type: String, default: null })
  errorCode?: string | null;

  @Prop({ type: String, enum: ['transient', 'permanent', null], default: null })
  errorSeverity?: 'transient' | 'permanent' | null;

  @Prop({ type: Number, default: null })
  httpStatus?: number | null;

  @Prop({ type: String, default: null })
  errorMessage?: string | null;
}

export const DeliveryAttemptSchema = SchemaFactory.createForClass(
  DeliveryAttemptSchemaClass,
);

DeliveryAttemptSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
DeliveryAttemptSchema.index(
  { tenantId: 1, messageId: 1, startedAt: -1, _id: -1 },
  { name: 'delivery_attempts_by_message' },
);
DeliveryAttemptSchema.index(
  { status: 1, startedAt: 1, _id: 1 },
  {
    name: 'delivery_attempts_stuck',
    partialFilterExpression: { status: 'started' },
  },
);
