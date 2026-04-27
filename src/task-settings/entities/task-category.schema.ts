import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type TaskCategoryDocument = HydratedDocument<TaskCategorySchemaClass>;

@Schema({
  timestamps: true,
  collection: 'task_categories',
  toJSON: { virtuals: true, getters: true },
})
export class TaskCategorySchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  apiName: string;

  @Prop({ default: 0 })
  sortOrder: number;
}

export const TaskCategorySchema = SchemaFactory.createForClass(
  TaskCategorySchemaClass,
);
TaskCategorySchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
TaskCategorySchema.index({ tenantId: 1, apiName: 1 }, { unique: true });
