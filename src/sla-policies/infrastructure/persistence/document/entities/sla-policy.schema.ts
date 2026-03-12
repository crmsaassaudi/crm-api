import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type SlaPolicySchemaDocument = HydratedDocument<SlaPolicySchemaClass>;

@Schema({
  timestamps: true,
  collection: 'sla_policies',
  toJSON: { virtuals: true, getters: true },
})
export class SlaPolicySchemaClass extends EntityDocumentHelper {
  @Prop({
    type: String,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenant: string;

  @Prop({ required: true })
  name: string;

  @Prop({
    required: true,
    enum: ['first_response', 'resolution', 'next_response'],
  })
  type: string;

  @Prop({
    type: [
      {
        segment: String,
        timeValue: Number,
        timeUnit: { type: String, enum: ['minutes', 'hours', 'days'] },
      },
    ],
    default: [],
  })
  targets: Array<{
    segment: string;
    timeValue: number;
    timeUnit: string;
  }>;

  @Prop({ default: true })
  enabled: boolean;

  @Prop({ default: 0 })
  priority: number;
}

export const SlaPolicySchema =
  SchemaFactory.createForClass(SlaPolicySchemaClass);

SlaPolicySchema.plugin(tenantFilterPlugin, { field: 'tenant' });
SlaPolicySchema.index({ tenant: 1, name: 1 }, { unique: true });
