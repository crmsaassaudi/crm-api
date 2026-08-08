import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';
import {
  TEMPLATE_PURPOSES,
  TEMPLATE_STATUSES,
  TEMPLATE_VISIBILITIES,
} from '../../../../domain/message-template';

export type MessageTemplateSchemaDocument =
  HydratedDocument<MessageTemplateSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'message_templates',
  toJSON: { virtuals: true, getters: true },
})
export class MessageTemplateSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ type: [String], enum: TEMPLATE_PURPOSES, required: true, default: [] })
  purpose: string[];

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({
    type: String,
    enum: TEMPLATE_STATUSES,
    required: true,
    default: 'draft',
  })
  status: string;

  @Prop({
    type: String,
    enum: TEMPLATE_VISIBILITIES,
    required: true,
    default: 'tenant',
  })
  visibility: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass', required: true })
  ownerId: string;

  @Prop({ required: false })
  shortcut?: string;

  @Prop({ required: true, default: 0 })
  usageCount: number;

  @Prop({ required: false })
  lastUsedAt?: Date;

  @Prop({ type: Date, default: null })
  deletedAt: Date | null;
}

export const MessageTemplateSchema = SchemaFactory.createForClass(
  MessageTemplateSchemaClass,
);
MessageTemplateSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// One live (non-deleted) template per name per tenant.
MessageTemplateSchema.index(
  { tenantId: 1, name: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
MessageTemplateSchema.index({ tenantId: 1, purpose: 1, deletedAt: 1 });
// One live shortcut per tenant — only agent_reply templates set this.
MessageTemplateSchema.index(
  { tenantId: 1, shortcut: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: { deletedAt: null },
  },
);
