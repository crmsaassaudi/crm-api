import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';
import { TEMPLATE_CHANNELS } from '../../../../domain/template-variant';
import { TEMPLATE_USAGE_CONTEXTS } from '../../../../domain/template-usage';

export type TemplateUsageSchemaDocument =
  HydratedDocument<TemplateUsageSchemaClass>;

/**
 * Append-only usage log — a compliance-style record, same philosophy as
 * `campaign_recipient`: never updated, never soft-deleted. One row per
 * *action* (an agent send, an automation node run, a campaign launch), not
 * per recipient — see TemplateUsageService for why.
 */
@Schema({
  timestamps: { createdAt: 'sentAt', updatedAt: false },
  collection: 'template_usages',
})
export class TemplateUsageSchemaClass extends EntityDocumentHelper {
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

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'TemplateVariantSchemaClass' })
  variantId?: string;

  @Prop({ type: String, enum: TEMPLATE_CHANNELS, required: true })
  channel: string;

  @Prop({ type: String, enum: TEMPLATE_USAGE_CONTEXTS, required: true })
  context: string;

  @Prop()
  contextId?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  actorId?: string;

  @Prop({ required: true, default: 1 })
  count: number;

  sentAt: Date;
}

export const TemplateUsageSchema = SchemaFactory.createForClass(
  TemplateUsageSchemaClass,
);
TemplateUsageSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
TemplateUsageSchema.index({ tenantId: 1, templateId: 1, sentAt: -1 });
