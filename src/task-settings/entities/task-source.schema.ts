import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type TaskSourceDocument = HydratedDocument<TaskSourceSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'task_sources',
  toJSON: { virtuals: true, getters: true },
})
export class TaskSourceSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ default: 0 })
  sortOrder: number;
}

export const TaskSourceSchema = SchemaFactory.createForClass(
  TaskSourceSchemaClass,
);
TaskSourceSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
