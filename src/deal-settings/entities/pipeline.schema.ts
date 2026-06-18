import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type PipelineDocument = HydratedDocument<PipelineSchemaClass>;

/**
 * Represents a Deal Pipeline (e.g. "Sales", "Enterprise", "Partnership").
 * Each tenant can have multiple pipelines. Deal stages are scoped to a pipeline.
 */
@Schema({
  timestamps: true,
  collection: 'deal_pipelines',
  toJSON: { virtuals: true, getters: true },
})
export class PipelineSchemaClass extends EntityDocumentHelper {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ type: String, default: null })
  description: string | null;

  /** When true, this pipeline is used as the default for new deals */
  @Prop({ default: false })
  isDefault: boolean;

  /** Order in which pipelines appear in the UI */
  @Prop({ default: 0 })
  sortOrder: number;

  /** Soft-delete: archived pipelines are hidden but data is preserved */
  @Prop({ default: false })
  isArchived: boolean;

  @Prop({ type: String, default: null })
  color: string | null;
}

export const PipelineSchema = SchemaFactory.createForClass(PipelineSchemaClass);
PipelineSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
PipelineSchema.index({ tenantId: 1, isArchived: 1, sortOrder: 1 });
PipelineSchema.index({ tenantId: 1, isDefault: 1 });
