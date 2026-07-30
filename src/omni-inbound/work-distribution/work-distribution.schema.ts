import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';

export type WorkItemDocument = HydratedDocument<WorkItemSchemaClass>;
export type QueueEntryDocument = HydratedDocument<QueueEntrySchemaClass>;
export type WorkOfferDocument = HydratedDocument<WorkOfferSchemaClass>;

@Schema({ timestamps: true, collection: 'omni_work_items' })
export class WorkItemSchemaClass extends EntityDocumentHelper {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  tenantId: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  conversationId: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  inboxId: string | null;
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  owningGroupId: string | null;
  @Prop({ type: String, required: true })
  channelType: string;
  @Prop({
    type: String,
    enum: ['queued', 'offered', 'assigned', 'active', 'wrap_up', 'completed'],
    default: 'queued',
  })
  status:
    | 'queued'
    | 'offered'
    | 'assigned'
    | 'active'
    | 'wrap_up'
    | 'completed';
  @Prop({ type: Number, default: 0 })
  priority: number;
  /** Relative workload units consumed by this channel (chat=1 by default). */
  @Prop({ type: Number, default: 1, min: 0.1 })
  capacityWeight: number;
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  assignedAgentId: string | null;
  @Prop({ type: Date, default: null })
  assignedAt: Date | null;
  @Prop({ type: Date, default: null })
  completedAt: Date | null;
  @Prop({ type: Date, default: null })
  wrapUpStartedAt: Date | null;
  @Prop({ type: Date, default: null })
  wrapUpDueAt: Date | null;
  @Prop({ type: Date, default: null })
  capacityReleasedAt: Date | null;
}

export const WorkItemSchema = SchemaFactory.createForClass(WorkItemSchemaClass);
WorkItemSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
WorkItemSchema.index(
  { tenantId: 1, conversationId: 1 },
  { unique: true, name: 'work_item_conversation_unique' },
);
WorkItemSchema.index(
  { status: 1, wrapUpDueAt: 1, _id: 1 },
  { name: 'work_item_wrap_up_completion' },
);
WorkItemSchema.index(
  { tenantId: 1, inboxId: 1, status: 1, priority: -1, createdAt: 1 },
  { name: 'work_item_distribution' },
);

@Schema({ timestamps: true, collection: 'omni_queue_entries' })
export class QueueEntrySchemaClass extends EntityDocumentHelper {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  tenantId: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  workItemId: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  inboxId: string | null;
  @Prop({
    type: String,
    enum: ['waiting', 'offered', 'assigned', 'cancelled'],
    default: 'waiting',
  })
  status: 'waiting' | 'offered' | 'assigned' | 'cancelled';
  @Prop({ type: Number, default: 0 })
  basePriority: number;
  @Prop({ type: Date, required: true, default: Date.now })
  queuedAt: Date;
  @Prop({ type: Date, default: null })
  offeredAt: Date | null;
  @Prop({ type: Date, default: null })
  dequeuedAt: Date | null;
}

export const QueueEntrySchema = SchemaFactory.createForClass(
  QueueEntrySchemaClass,
);
QueueEntrySchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
QueueEntrySchema.index(
  { tenantId: 1, workItemId: 1 },
  {
    unique: true,
    name: 'active_queue_entry_per_work_item',
    partialFilterExpression: { status: { $in: ['waiting', 'offered'] } },
  },
);
QueueEntrySchema.index(
  { tenantId: 1, inboxId: 1, status: 1, basePriority: -1, queuedAt: 1 },
  { name: 'queue_pick_next' },
);

@Schema({ timestamps: true, collection: 'omni_work_offers' })
export class WorkOfferSchemaClass extends EntityDocumentHelper {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  tenantId: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  workItemId: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  queueEntryId: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  agentId: string;
  @Prop({ type: Number, default: 1, min: 0.1 })
  capacityWeight: number;
  @Prop({
    type: String,
    enum: ['offered', 'accepted', 'declined', 'expired', 'cancelled'],
    default: 'offered',
  })
  status: 'offered' | 'accepted' | 'declined' | 'expired' | 'cancelled';
  @Prop({ type: Date, required: true })
  expiresAt: Date;
  @Prop({ type: Date, default: null })
  respondedAt: Date | null;
  @Prop({ type: String, default: null })
  declineReason: string | null;
}

export const WorkOfferSchema =
  SchemaFactory.createForClass(WorkOfferSchemaClass);
WorkOfferSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
WorkOfferSchema.index(
  { tenantId: 1, workItemId: 1 },
  {
    unique: true,
    name: 'one_open_offer_per_work_item',
    partialFilterExpression: { status: 'offered' },
  },
);
WorkOfferSchema.index(
  { status: 1, expiresAt: 1, _id: 1 },
  { name: 'offer_expiry_recovery' },
);
WorkOfferSchema.index(
  { tenantId: 1, agentId: 1, status: 1, expiresAt: 1 },
  { name: 'agent_open_offers' },
);
