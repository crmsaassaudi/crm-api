import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type AccountTypeDocument = HydratedDocument<AccountTypeSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'account_types',
  toJSON: { virtuals: true, getters: true },
})
export class AccountTypeSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  apiName: string;

  @Prop({ default: 0 })
  sortOrder: number;
}

export const AccountTypeSchema = SchemaFactory.createForClass(
  AccountTypeSchemaClass,
);
AccountTypeSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
AccountTypeSchema.index({ tenantId: 1, apiName: 1 }, { unique: true });
