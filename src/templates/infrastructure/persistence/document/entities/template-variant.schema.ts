import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';
import {
  TEMPLATE_CHANNELS,
  TEMPLATE_CONTENT_TYPES,
  WHATSAPP_TEMPLATE_CATEGORIES,
  WHATSAPP_TEMPLATE_STATUSES,
} from '../../../../domain/template-variant';

export type TemplateVariantSchemaDocument =
  HydratedDocument<TemplateVariantSchemaClass>;

@Schema({ _id: false })
class ButtonSubSchema {
  @Prop({ required: true })
  id: string;

  @Prop({ required: true })
  title: string;
}

@Schema({ _id: false })
class CardSubSchema {
  @Prop({ required: true })
  title: string;

  @Prop()
  subtitle?: string;

  @Prop()
  imageUrl?: string;

  @Prop({ type: [ButtonSubSchema], default: [] })
  buttons?: ButtonSubSchema[];
}

@Schema({ _id: false })
class ProviderBindingSubSchema {
  @Prop({ required: true, default: 'meta_whatsapp' })
  provider: string;

  @Prop()
  externalId?: string;

  @Prop({ enum: WHATSAPP_TEMPLATE_CATEGORIES })
  category?: string;

  @Prop({ enum: WHATSAPP_TEMPLATE_STATUSES, default: 'PENDING' })
  approvalStatus?: string;

  @Prop()
  rejectionReason?: string;

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  components?: any[];

  @Prop()
  syncedAt?: Date;
}

@Schema({
  timestamps: true,
  collection: 'template_variants',
  toJSON: { virtuals: true, getters: true },
})
export class TemplateVariantSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'MessageTemplateSchemaClass',
    required: true,
    index: true,
  })
  templateId: string;

  @Prop({ type: String, enum: TEMPLATE_CHANNELS, required: true })
  channel: string;

  @Prop({ required: true, default: 'vi' })
  locale: string;

  @Prop({
    type: String,
    enum: TEMPLATE_CONTENT_TYPES,
    required: true,
    default: 'text',
  })
  contentType: string;

  @Prop()
  subject?: string;

  @Prop()
  body?: string;

  @Prop()
  htmlContent?: string;

  @Prop({ type: String })
  designJson?: string;

  @Prop({ type: [ButtonSubSchema], default: [] })
  buttons?: ButtonSubSchema[];

  @Prop({ type: [CardSubSchema], default: [] })
  cards?: CardSubSchema[];

  @Prop({ type: [String], default: [] })
  attachments?: string[];

  @Prop({ type: ProviderBindingSubSchema, required: false })
  providerBinding?: ProviderBindingSubSchema;
}

export const TemplateVariantSchema = SchemaFactory.createForClass(
  TemplateVariantSchemaClass,
);
TemplateVariantSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
TemplateVariantSchema.index(
  { tenantId: 1, templateId: 1, channel: 1, locale: 1 },
  { unique: true },
);
TemplateVariantSchema.index({ tenantId: 1, 'providerBinding.externalId': 1 });
