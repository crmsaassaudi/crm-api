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
  @Prop({ type: String, ref: 'TenantSchemaClass', required: true, index: true })
  tenant: string;

  @Prop({ required: true, unique: true, index: true })
  ticketNumber: string;

  @Prop({ required: true, index: true })
  subject: string;

  @Prop()
  description?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  requester?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  assignee?: string;

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
  createdBy: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  updatedBy: string;

  @Prop({ default: now })
  createdAt: Date;

  @Prop({ default: now })
  updatedAt: Date;

  @Prop()
  deletedAt?: Date;
}

export const TicketSchema = SchemaFactory.createForClass(TicketSchemaClass);

TicketSchema.plugin(tenantFilterPlugin, { field: 'tenant' });
TicketSchema.index({ tenant: 1, ticketNumber: 1 });
TicketSchema.index({ tenant: 1, status: 1 });
