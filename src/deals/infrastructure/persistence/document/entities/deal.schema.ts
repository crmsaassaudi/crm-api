import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type DealSchemaDocument = HydratedDocument<DealSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'deals',
  toJSON: {
    virtuals: true,
    getters: true,
  },
})
export class DealSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true, index: true })
  title: string;

  @Prop({ required: true, index: true })
  name: string;

  @Prop({ required: true })
  pipeline: string;

  @Prop({ required: true, index: true })
  stage: string;

  @Prop({ type: Number })
  probability?: number;

  @Prop({ default: 0 })
  value: number;

  @Prop({ default: 'USD' })
  currency: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'AccountSchemaClass' })
  accountId?: string;

  @Prop()
  accountName?: string;

  @Prop({
    type: [{ type: MongooseSchema.Types.ObjectId, ref: 'ContactSchemaClass' }],
    default: [],
  })
  contactIds?: string[];

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  ownerId?: string;

  @Prop()
  description?: string;

  @Prop()
  source?: string;

  @Prop()
  lostReason?: string;

  @Prop({ type: [String], default: [] })
  tags?: string[];

  @Prop({ type: MongooseSchema.Types.Mixed })
  customFields?: Record<string, any>;

  @Prop()
  closeDate?: Date;

  @Prop()
  wonAt?: Date;

  @Prop()
  lostAt?: Date;

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
}

export const DealSchema = SchemaFactory.createForClass(DealSchemaClass);

DealSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

DealSchema.virtual('owner', {
  ref: 'UserSchemaClass',
  localField: 'ownerId',
  foreignField: '_id',
  justOne: true,
});
