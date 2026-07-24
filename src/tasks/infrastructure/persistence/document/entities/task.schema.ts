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
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId!: string;

  @Prop({ required: true, index: true })
  title!: string;

  @Prop()
  description?: string;

  @Prop({ required: true })
  dueDate!: Date;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TaskStatusSchemaClass',
    index: true,
  })
  statusId?: string;

  @Prop({ required: true, default: 'MEDIUM', index: true })
  priority!: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'TaskCategorySchemaClass' })
  categoryId?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  ownerId?: string;

  // Business Unit sub-partition (reserved; nullable & inert for now).
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null, index: true })
  businessUnitId?: string | null;

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

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'TaskSourceSchemaClass' })
  sourceId?: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  createdById!: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  updatedById!: string;

  @Prop({ default: now })
  createdAt: Date;

  @Prop({ default: now })
  updatedAt: Date;

  @Prop()
  deletedAt?: Date;

  // ──────────────────── RECURRENCE ────────────────────

  /** Whether this is a template task that auto-spawns children */
  @Prop({ default: false, index: true })
  isRecurring?: boolean;

  /** Recurrence rule: none / daily / weekly / monthly / yearly */
  @Prop({
    enum: ['none', 'daily', 'weekly', 'monthly', 'yearly'],
    default: 'none',
  })
  recurrenceRule?: 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

  /** How many units between occurrences (e.g., 2 = every 2 weeks) */
  @Prop({ default: 1 })
  recurrenceInterval?: number;

  /** Date after which no more occurrences should be created */
  @Prop()
  recurrenceEndsAt?: Date;

  /** Next scheduled occurrence date (maintained by the cron job) */
  @Prop({ index: true })
  nextOccurrenceAt?: Date;

  /** If this task was auto-created by a recurrence, its parent template ID */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'TaskSchemaClass' })
  parentTaskId?: string;
}

export const TaskSchema = SchemaFactory.createForClass(TaskSchemaClass);

TaskSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
TaskSchema.index({ tenantId: 1, status: 1 });
TaskSchema.index({ tenantId: 1, dueDate: 1 });
TaskSchema.index({ tenantId: 1, ownerId: 1 }, { name: 'tenant_owner_lookup' });
TaskSchema.index(
  { isRecurring: 1, nextOccurrenceAt: 1, deletedAt: 1 },
  { name: 'recurring_tasks_cron', sparse: true },
);

TaskSchema.virtual('owner', {
  ref: 'UserSchemaClass',
  localField: 'ownerId',
  foreignField: '_id',
  justOne: true,
});

TaskSchema.virtual('taskStatus', {
  ref: 'TaskStatusSchemaClass',
  localField: 'statusId',
  foreignField: '_id',
  justOne: true,
});

TaskSchema.virtual('taskCategory', {
  ref: 'TaskCategorySchemaClass',
  localField: 'categoryId',
  foreignField: '_id',
  justOne: true,
});

TaskSchema.virtual('taskSource', {
  ref: 'TaskSourceSchemaClass',
  localField: 'sourceId',
  foreignField: '_id',
  justOne: true,
});
