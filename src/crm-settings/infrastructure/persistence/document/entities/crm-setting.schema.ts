import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type CrmSettingSchemaDocument = HydratedDocument<CrmSettingSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'crm_settings',
  toJSON: {
    virtuals: true,
    getters: true,
  },
})
export class CrmSettingSchemaClass extends EntityDocumentHelper {
  @Prop({ type: String, ref: 'TenantSchemaClass', required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  key: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  value: any;
}

export const CrmSettingSchema = SchemaFactory.createForClass(
  CrmSettingSchemaClass,
);

CrmSettingSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
CrmSettingSchema.index({ tenantId: 1, key: 1 }, { unique: true });
