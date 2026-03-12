import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type TagSchemaDocument = HydratedDocument<TagSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'tags',
  toJSON: { virtuals: true, getters: true },
})
export class TagSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: String,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenant: string;

  @Prop({ required: true })
  name: string;

  @Prop({ default: '#6b7280' })
  color: string;

  @Prop({
    required: true,
    enum: ['Contact', 'Account', 'Deal', 'Ticket', 'Conversation', 'Task'],
  })
  scope: string;

  @Prop({ type: String, default: null })
  autoRule: string | null;
}

export const TagSchema = SchemaFactory.createForClass(TagSchemaClass);

TagSchema.plugin(tenantFilterPlugin, { field: 'tenant' });
TagSchema.index({ tenant: 1, name: 1, scope: 1 }, { unique: true });
