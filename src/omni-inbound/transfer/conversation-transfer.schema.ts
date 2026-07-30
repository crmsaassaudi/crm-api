import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';

export type ConversationTransferDocument =
  HydratedDocument<ConversationTransferSchemaClass>;

@Schema({ timestamps: true, collection: 'omni_conversation_transfers' })
export class ConversationTransferSchemaClass extends EntityDocumentHelper {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  tenantId: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  conversationId: string;

  @Prop({ type: String, enum: ['cold', 'warm', 'consult'], required: true })
  type: 'cold' | 'warm' | 'consult';

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  sourceAgentId: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  targetAgentId: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  targetGroupId: string | null;

  @Prop({
    type: String,
    enum: [
      'requested',
      'consulting',
      'accepted',
      'rejected',
      'cancelled',
      'expired',
      'completed',
    ],
    required: true,
  })
  status:
    | 'requested'
    | 'consulting'
    | 'accepted'
    | 'rejected'
    | 'cancelled'
    | 'expired'
    | 'completed';

  @Prop({ type: String, maxlength: 500, default: null })
  reason: string | null;

  @Prop({ type: String, maxlength: 4_000, default: null })
  handoffNote: string | null;

  @Prop({ type: Date, required: true })
  expiresAt: Date;

  @Prop({ type: Date, default: null })
  respondedAt: Date | null;

  @Prop({ type: Date, default: null })
  completedAt: Date | null;

  @Prop({ type: Boolean, default: false })
  consultCapacityReserved: boolean;

  @Prop({ type: Number, default: 1, min: 0.1 })
  capacityWeight: number;
}

export const ConversationTransferSchema = SchemaFactory.createForClass(
  ConversationTransferSchemaClass,
);
ConversationTransferSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
ConversationTransferSchema.index(
  { tenantId: 1, conversationId: 1 },
  {
    unique: true,
    name: 'one_open_transfer_per_conversation',
    partialFilterExpression: {
      status: { $in: ['requested', 'consulting', 'accepted'] },
    },
  },
);
ConversationTransferSchema.index(
  { tenantId: 1, targetAgentId: 1, status: 1, expiresAt: 1 },
  { name: 'target_transfer_inbox' },
);
ConversationTransferSchema.index(
  { status: 1, expiresAt: 1, _id: 1 },
  { name: 'transfer_expiry_recovery' },
);
