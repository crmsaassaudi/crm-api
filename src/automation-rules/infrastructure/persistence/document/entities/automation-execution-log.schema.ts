import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

// ── Sub-document types ─────────────────────────────────────────────────────

export type ExecutionStatus =
  | 'running'
  | 'success'
  | 'failed'
  | 'loop_blocked'
  | 'skipped_run_once';

export interface ExecutionStep {
  nodeId: string;
  nodeName: string;
  nodeType: 'trigger' | 'condition' | 'action';
  branch?: 'matched' | 'not_matched';
  status: 'success' | 'failed' | 'skipped';
  input: Record<string, any>;
  output?: Record<string, any>;
  error?: { code: string; message: string };
  startedAt: Date;
  completedAt: Date;
  duration: number; // milliseconds
}

// ── Schema ─────────────────────────────────────────────────────────────────

export type AutomationExecutionLogDocument =
  HydratedDocument<AutomationExecutionLogSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'automation_execution_logs',
  toJSON: { virtuals: true, getters: true },
})
export class AutomationExecutionLogSchemaClass {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'AutomationWorkflowSchemaClass',
    required: true,
  })
  workflowId: string;

  @Prop({ required: true })
  workflowName: string;

  @Prop({ required: true })
  recordId: string;

  @Prop({
    required: true,
    enum: ['Lead', 'Contact', 'Ticket'],
  })
  recordType: string;

  @Prop({
    required: true,
    enum: ['running', 'success', 'failed', 'loop_blocked', 'skipped_run_once'],
    default: 'running',
  })
  status: ExecutionStatus;

  @Prop({ default: 0 })
  automationDepth: number;

  @Prop({ type: Date, required: true })
  startedAt: Date;

  @Prop({ type: Date, default: null })
  completedAt: Date | null;

  @Prop({ default: 0 })
  duration: number; // milliseconds

  @Prop({
    type: [
      {
        nodeId: { type: String, required: true },
        nodeName: { type: String, required: true },
        nodeType: {
          type: String,
          required: true,
          enum: ['trigger', 'condition', 'action'],
        },
        branch: {
          type: String,
          enum: ['matched', 'not_matched', null],
          default: null,
        },
        status: {
          type: String,
          required: true,
          enum: ['success', 'failed', 'skipped'],
        },
        input: { type: MongooseSchema.Types.Mixed, default: {} },
        output: { type: MongooseSchema.Types.Mixed, default: null },
        error: {
          type: {
            code: { type: String },
            message: { type: String },
          },
          default: null,
        },
        startedAt: { type: Date, required: true },
        completedAt: { type: Date, required: true },
        duration: { type: Number, default: 0 },
      },
    ],
    default: [],
  })
  steps: ExecutionStep[];

  @Prop({
    type: {
      code: { type: String },
      message: { type: String },
      nodeId: { type: String },
    },
    default: null,
  })
  error?: { code: string; message: string; nodeId?: string };

  @Prop({ type: Date, required: true })
  expireAt: Date; // TTL — createdAt + 30 days
}

export const AutomationExecutionLogSchema = SchemaFactory.createForClass(
  AutomationExecutionLogSchemaClass,
);

AutomationExecutionLogSchema.plugin(tenantFilterPlugin, {
  field: 'tenantId',
});

// ── Indexes ────────────────────────────────────────────────────────────────

// Logs per workflow (sorted newest first)
AutomationExecutionLogSchema.index({
  tenantId: 1,
  workflowId: 1,
  startedAt: -1,
});

// Logs per record
AutomationExecutionLogSchema.index({ tenantId: 1, recordId: 1 });

// Filter by status
AutomationExecutionLogSchema.index({
  tenantId: 1,
  status: 1,
  startedAt: -1,
});

// TTL index — auto-delete expired logs (30-day retention)
AutomationExecutionLogSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
