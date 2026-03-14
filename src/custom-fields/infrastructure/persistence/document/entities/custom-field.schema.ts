import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type CustomFieldSchemaDocument =
  HydratedDocument<CustomFieldSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'custom_fields',
  toJSON: { virtuals: true, getters: true },
})
export class CustomFieldSchemaClass extends EntityDocumentHelper {
  @Prop({ type: String, required: true, index: true })
  tenant: string;

  @Prop({ required: true, index: true })
  module: string;

  @Prop({ required: true })
  internalKey: string;

  @Prop({ required: true })
  displayLabel: string;

  @Prop({ required: true })
  fieldType: string;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: '' })
  section: string;

  @Prop({ default: 0 })
  orderIndex: number;

  @Prop({ type: MongooseSchema.Types.Mixed })
  validation?: Record<string, any>;

  @Prop({ type: MongooseSchema.Types.Mixed })
  governance?: Record<string, any>;

  @Prop()
  objectView?: string;

  @Prop()
  placeholder?: string;

  @Prop({ type: [MongooseSchema.Types.Mixed] })
  options?: { label: string; value: string }[];
}

export const CustomFieldSchema = SchemaFactory.createForClass(
  CustomFieldSchemaClass,
);

CustomFieldSchema.plugin(tenantFilterPlugin, { field: 'tenant' });
CustomFieldSchema.index({ tenant: 1, module: 1 });
CustomFieldSchema.index(
  { tenant: 1, internalKey: 1, module: 1 },
  { unique: true },
);
