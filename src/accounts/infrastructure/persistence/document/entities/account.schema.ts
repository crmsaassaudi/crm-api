import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type AccountSchemaDocument = HydratedDocument<AccountSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'accounts',
  toJSON: {
    virtuals: true,
    getters: true,
  },
})
export class AccountSchemaClass extends EntityDocumentHelper {
  @Prop({ type: String, ref: 'TenantSchemaClass', required: true, index: true })
  tenant: string;

  @Prop({ required: true, index: true })
  name: string;

  @Prop()
  website?: string;

  @Prop({ index: true })
  industry?: string;

  @Prop()
  type?: string;

  @Prop()
  phone?: string;

  @Prop()
  taxId?: string;

  @Prop({ type: Number })
  annualRevenue?: number;

  @Prop({ type: Number })
  numberOfEmployees?: number;

  @Prop()
  billingAddress?: string;

  @Prop()
  shippingAddress?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  owner?: string;

  @Prop({ default: 'active', index: true })
  status?: string;

  @Prop({ default: false })
  isArchived?: boolean;

  @Prop({ type: MongooseSchema.Types.Mixed })
  customFields?: Record<string, any>;

  @Prop({ type: [String], default: [] })
  tags?: string[];

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

export const AccountSchema = SchemaFactory.createForClass(AccountSchemaClass);

AccountSchema.plugin(tenantFilterPlugin, { field: 'tenant' });
