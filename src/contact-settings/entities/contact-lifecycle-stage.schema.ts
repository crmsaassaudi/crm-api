import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type ContactLifecycleStageDocument =
  HydratedDocument<ContactLifecycleStageSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'contact_lifecycle_stages',
  toJSON: { virtuals: true, getters: true },
})
export class ContactLifecycleStageSchemaClass extends EntityDocumentHelper {
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
}

export const ContactLifecycleStageSchema = SchemaFactory.createForClass(
  ContactLifecycleStageSchemaClass,
);
ContactLifecycleStageSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
ContactLifecycleStageSchema.index(
  { tenantId: 1, apiName: 1 },
  { unique: true },
);
ContactLifecycleStageSchema.index({ tenantId: 1, sortOrder: 1 });
