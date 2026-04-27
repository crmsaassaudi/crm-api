import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type ContactStatusDocument = HydratedDocument<ContactStatusSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'contact_statuses',
  toJSON: { virtuals: true, getters: true },
})
export class ContactStatusSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true })
  label: string;

  @Prop({ required: true })
  apiName: string;

  @Prop({ default: '#3b82f6' })
  color: string;

  @Prop({ default: 0 })
  sortOrder: number;

  @Prop({ default: false })
  isDefault: boolean;

  @Prop({ default: false })
  isTerminal: boolean;
}

export const ContactStatusSchema = SchemaFactory.createForClass(
  ContactStatusSchemaClass,
);
ContactStatusSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
ContactStatusSchema.index({ tenantId: 1, apiName: 1 }, { unique: true });
ContactStatusSchema.index({ tenantId: 1, sortOrder: 1 });
