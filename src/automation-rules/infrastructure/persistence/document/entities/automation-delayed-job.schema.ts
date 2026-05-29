import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { AutomationDelayedJobData } from '../../../../queue/automation-queue.constants';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type AutomationDelayedJobStatus =
  | 'pending'
  | 'enqueued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AutomationDelayedJobDocument =
  HydratedDocument<AutomationDelayedJobSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'automation_delayed_jobs',
  toJSON: { virtuals: true, getters: true },
})
export class AutomationDelayedJobSchemaClass {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true, unique: true, index: true })
  jobKey: string;

  @Prop({
    type: String,
    required: true,
    enum: [
      'pending',
      'enqueued',
      'processing',
      'completed',
      'failed',
      'cancelled',
    ],
    default: 'pending',
  })
  status: AutomationDelayedJobStatus;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'AutomationExecutionLogSchemaClass',
    required: true,
    index: true,
  })
  executionId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'AutomationWorkflowSchemaClass',
    required: true,
    index: true,
  })
  workflowId: string;

  @Prop({ required: true })
  resumeFromNodeId: string;

  @Prop({ required: true })
  recordId: string;

  @Prop({
    type: String,
    required: true,
    enum: ['Lead', 'Contact', 'Ticket', 'Deal', 'Account', 'Task'],
  })
  recordType: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  payload: AutomationDelayedJobData;

  @Prop({ type: Date, required: true, index: true })
  resumeAt: Date;

  @Prop({ type: Date, default: null })
  enqueuedAt: Date | null;

  @Prop({ type: Date, default: null })
  processingStartedAt: Date | null;

  @Prop({ type: Date, default: null })
  completedAt: Date | null;

  @Prop({ type: Date, default: null })
  failedAt: Date | null;

  @Prop({ default: 0 })
  enqueueAttempts: number;

  @Prop({ default: 0 })
  processAttempts: number;

  @Prop({
    type: {
      code: { type: String },
      message: { type: String },
    },
    default: null,
  })
  lastError?: { code?: string; message: string } | null;

  @Prop({ type: Date, default: null })
  expireAt: Date | null;
}

export const AutomationDelayedJobSchema = SchemaFactory.createForClass(
  AutomationDelayedJobSchemaClass,
);

AutomationDelayedJobSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

AutomationDelayedJobSchema.index({ status: 1, resumeAt: 1 });
AutomationDelayedJobSchema.index({ tenantId: 1, executionId: 1 });
AutomationDelayedJobSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
