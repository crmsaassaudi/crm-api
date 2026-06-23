import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type RichMessageTemplateSchemaDocument =
  HydratedDocument<RichMessageTemplateSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'rich_message_templates',
  toJSON: { virtuals: true, getters: true },
})
export class RichMessageTemplateSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ default: '' })
  shortcut: string;

  @Prop({
    type: String,
    required: true,
    enum: ['interactive', 'carousel'],
  })
  type: string;

  @Prop({ type: [String], default: ['all'] })
  channelTypes: string[];

  // ── Interactive fields ──
  @Prop({ default: '' })
  body: string;

  @Prop({
    type: [{ id: String, title: String }],
    default: [],
  })
  buttons: Array<{ id: string; title: string }>;

  // ── Carousel fields ──
  @Prop({
    type: [
      {
        title: String,
        subtitle: String,
        imageUrl: String,
        buttons: [{ id: String, title: String }],
      },
    ],
    default: [],
  })
  cards: Array<{
    title: string;
    subtitle?: string;
    imageUrl?: string;
    buttons?: Array<{ id: string; title: string }>;
  }>;

  @Prop({
    type: String,
    default: 'Public',
    enum: ['Public', 'Private'],
  })
  scope: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  createdById: string;

  @Prop({ default: true })
  isActive: boolean;
}

export const RichMessageTemplateSchema = SchemaFactory.createForClass(
  RichMessageTemplateSchemaClass,
);

RichMessageTemplateSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
RichMessageTemplateSchema.index({ tenantId: 1, type: 1 });
RichMessageTemplateSchema.index({ tenantId: 1, shortcut: 1 });
