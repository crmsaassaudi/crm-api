import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type TaskSchemaDocument = HydratedDocument<TaskSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'tasks',
  toJSON: {
    virtuals: true,
    getters: true,
  },
})
export class TaskSchemaClass extends EntityDocumentHelper {
  @Prop({ type: String, ref: 'TenantSchemaClass', required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  title: string;

  @Prop()
  description?: string;

  @Prop({ required: true })
  dueDate: Date;

  @Prop({ required: true, default: 'not_started', index: true })
  status: string;

  @Prop({ required: true, default: 'MEDIUM', index: true })
  priority: string;

  @Prop({ default: 'todo' })
  category: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  assignedToId?: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  relatedTo?: {
    type: string;
    _id: string;
    name: string;
  };

  @Prop({ type: [String], default: [] })
  tags?: string[];

  @Prop()
  reminderAt?: Date;

  @Prop()
  completedAt?: Date;

  @Prop()
  source?: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  createdById: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  updatedById: string;

  @Prop({ default: now })
  createdAt: Date;

  @Prop({ default: now })
  updatedAt: Date;

  @Prop()
  deletedAt?: Date;
}

export const TaskSchema = SchemaFactory.createForClass(TaskSchemaClass);

TaskSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
TaskSchema.index({ tenantId: 1, status: 1 });
TaskSchema.index({ tenantId: 1, dueDate: 1 });

TaskSchema.virtual('assignedTo', {
  ref: 'UserSchemaClass',
  localField: 'assignedToId',
  foreignField: '_id',
  justOne: true,
});
