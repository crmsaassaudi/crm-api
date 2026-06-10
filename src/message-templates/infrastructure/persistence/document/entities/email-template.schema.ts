import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type EmailTemplateSchemaDocument =
  HydratedDocument<EmailTemplateSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'email_templates',
  toJSON: { virtuals: true, getters: true },
})
export class EmailTemplateSchemaClass extends EntityDocumentHelper {
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
  subject: string;

  @Prop({ required: true })
  htmlContent: string;

  @Prop({ type: String, required: false })
  designJson?: string;
}

export const EmailTemplateSchema = SchemaFactory.createForClass(
  EmailTemplateSchemaClass,
);
EmailTemplateSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
EmailTemplateSchema.index({ tenantId: 1, name: 1 }, { unique: true });
