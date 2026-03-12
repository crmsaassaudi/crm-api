import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type GroupSchemaDocument = HydratedDocument<GroupSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'groups',
  toJSON: { virtuals: true, getters: true },
})
export class GroupSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: String,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenant: string;

  @Prop({ required: true, trim: true, maxlength: 100 })
  name: string;

  @Prop({ type: String, default: null })
  description?: string | null;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'GroupSchemaClass',
    default: null,
  })
  parentGroup: string | null;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    default: null,
  })
  manager?: string | null;

  @Prop({
    type: [{ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' }],
    default: [],
  })
  members: string[];

  @Prop({ type: [String], default: [] })
  permissions: string[];

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ type: String, default: null })
  color?: string | null;
}

export const GroupSchema = SchemaFactory.createForClass(GroupSchemaClass);

GroupSchema.plugin(tenantFilterPlugin, { field: 'tenant' });
GroupSchema.index({ tenant: 1, name: 1 }, { unique: true });
