import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type TicketSchemaDocument = HydratedDocument<TicketSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'tickets',
  toJSON: {
    virtuals: true,
    getters: true,
  },
})
export class TicketSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true, unique: true, index: true })
  ticketNumber: string;

  @Prop({ required: true, index: true })
  subject: string;

  @Prop()
  description?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  requesterId?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  assigneeId?: string;

  @Prop({ required: true, default: 'new', index: true })
  status: string;

  @Prop({ required: true, default: 'MEDIUM', index: true })
  priority: string;

  @Prop({ default: 'new' })
  lifecycleStage?: string;

  @Prop()
  channel?: string;

  @Prop()
  source?: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  relatedTo?: {
    type: string;
    _id: string;
    name: string;
  };

  @Prop({ default: false })
  slaBreached?: boolean;

  @Prop({ type: [String], default: [] })
  tags?: string[];

  @Prop({ type: MongooseSchema.Types.Mixed })
  customFields?: Record<string, any>;

  @Prop()
  resolvedAt?: Date;

  @Prop()
  closedAt?: Date;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  createdById: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  updatedById: string;

  @Prop({ default: now })
  createdAt: Date;

  @Prop({ default: now })
  updatedAt: Date;

  @Prop()
  deletedAt?: Date;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'OmniConversationSchemaClass',
    default: null,
  })
  omniConversationId?: string;

  @Prop({
    type: [
      { type: MongooseSchema.Types.ObjectId, ref: 'OmniMessageSchemaClass' },
    ],
    default: [],
  })
  linkedMessageIds?: string[];
}

export const TicketSchema = SchemaFactory.createForClass(TicketSchemaClass);

TicketSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
TicketSchema.index({ tenantId: 1, ticketNumber: 1 });
TicketSchema.index({ tenantId: 1, status: 1 });
TicketSchema.index(
  { omniConversationId: 1 },
  { name: 'ticket_omni_conversation' },
);

TicketSchema.virtual('requester', {
  ref: 'UserSchemaClass',
  localField: 'requesterId',
  foreignField: '_id',
  justOne: true,
});

TicketSchema.virtual('assignee', {
  ref: 'UserSchemaClass',
  localField: 'assigneeId',
  foreignField: '_id',
  justOne: true,
});
