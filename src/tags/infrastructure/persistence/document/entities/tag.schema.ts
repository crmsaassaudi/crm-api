import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
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
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ default: '#6b7280' })
  color: string;

  @Prop({
    type: String,
    required: true,
    enum: ['Contact', 'Account', 'Deal', 'Ticket', 'Conversation', 'Task'],
  })
  scope: string;

  @Prop({ type: Number, default: 0 })
  order: number;

  @Prop({ type: [String], default: [] })
  channelIds: string[];
}

export const TagSchema = SchemaFactory.createForClass(TagSchemaClass);

TagSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
TagSchema.index({ tenantId: 1, name: 1, scope: 1 }, { unique: true });
TagSchema.index({ tenantId: 1, scope: 1, order: 1 });
