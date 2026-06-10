import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type SMSTemplateSchemaDocument =
  HydratedDocument<SMSTemplateSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'sms_templates',
  toJSON: { virtuals: true, getters: true },
})
export class SMSTemplateSchemaClass extends EntityDocumentHelper {
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
  message: string;
}

export const SMSTemplateSchema = SchemaFactory.createForClass(
  SMSTemplateSchemaClass,
);
SMSTemplateSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
SMSTemplateSchema.index({ tenantId: 1, name: 1 }, { unique: true });
