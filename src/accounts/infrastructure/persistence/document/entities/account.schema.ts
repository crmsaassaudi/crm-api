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
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true, index: true })
  name: string;

  @Prop()
  website?: string;

  @Prop({ index: true })
  industry?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'AccountTypeSchemaClass' })
  typeId?: string;

  @Prop({ type: [String], default: [] })
  emails?: string[];

  @Prop({ type: [String], default: [] })
  phones?: string[];

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
  ownerId?: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'AccountStatusSchemaClass',
    index: true,
  })
  statusId?: string;

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

export const AccountSchema = SchemaFactory.createForClass(AccountSchemaClass);

AccountSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
AccountSchema.index(
  { tenantId: 1, ownerId: 1 },
  { name: 'tenant_owner_lookup' },
);

AccountSchema.virtual('owner', {
  ref: 'UserSchemaClass',
  localField: 'ownerId',
  foreignField: '_id',
  justOne: true,
});

AccountSchema.virtual('accountStatus', {
  ref: 'AccountStatusSchemaClass',
  localField: 'statusId',
  foreignField: '_id',
  justOne: true,
});

AccountSchema.virtual('accountType', {
  ref: 'AccountTypeSchemaClass',
  localField: 'typeId',
  foreignField: '_id',
  justOne: true,
});
