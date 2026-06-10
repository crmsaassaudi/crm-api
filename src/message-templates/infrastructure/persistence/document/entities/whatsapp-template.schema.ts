import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type WhatsAppTemplateSchemaDocument =
  HydratedDocument<WhatsAppTemplateSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'whatsapp_templates',
  toJSON: { virtuals: true, getters: true },
})
export class WhatsAppTemplateSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true, enum: ['UTILITY', 'MARKETING'] })
  category: string;

  @Prop({ required: true, default: 'vi' })
  language: string;

  @Prop({
    required: true,
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DELETED'],
    default: 'PENDING',
  })
  status: string;

  @Prop({ required: false })
  metaTemplateId?: string;

  @Prop({ type: [MongooseSchema.Types.Mixed], required: true })
  components: any[];
}

export const WhatsAppTemplateSchema = SchemaFactory.createForClass(
  WhatsAppTemplateSchemaClass,
);
WhatsAppTemplateSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
WhatsAppTemplateSchema.index({ tenantId: 1, name: 1 }, { unique: true });
