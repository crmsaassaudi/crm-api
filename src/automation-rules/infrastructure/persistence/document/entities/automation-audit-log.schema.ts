import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

// ── Types ──────────────────────────────────────────────────────────────────

export type AuditAction =
  | 'created'
  | 'updated'
  | 'published'
  | 'status_changed'
  | 'deleted'
  | 'duplicated';

export interface AuditDiffEntry {
  field: string; // e.g. "nodes", "name", "triggerConfig.object"
  before: any; // Previous value (null for created)
  after: any; // New value (null for deleted)
}

const AUDIT_LOG_RETENTION_DAYS = 365;

// ── Schema ─────────────────────────────────────────────────────────────────

export type AutomationAuditLogDocument =
  HydratedDocument<AutomationAuditLogSchemaClass>;

@Schema({
  timestamps: false,
  collection: 'automation_audit_logs',
  toJSON: { virtuals: true, getters: true },
})
export class AutomationAuditLogSchemaClass {
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

  @Prop({
    required: true,
    enum: [
      'created',
      'updated',
      'published',
      'status_changed',
      'deleted',
      'duplicated',
    ],
  })
  action: AuditAction;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  userId: string;

  @Prop({ type: Date, required: true })
  timestamp: Date;

  @Prop({
    type: [
      {
        field: { type: String, required: true },
        before: { type: MongooseSchema.Types.Mixed, default: null },
        after: { type: MongooseSchema.Types.Mixed, default: null },
      },
    ],
    default: null,
  })
  diff: AuditDiffEntry[] | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  metadata: Record<string, any> | null;

  @Prop({ type: Date, required: true })
  expireAt: Date; // TTL: 365 days
}

export { AUDIT_LOG_RETENTION_DAYS };

export const AutomationAuditLogSchema = SchemaFactory.createForClass(
  AutomationAuditLogSchemaClass,
);

AutomationAuditLogSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// ── Indexes ────────────────────────────────────────────────────────────────

// Per-workflow audit history (sorted newest first)
AutomationAuditLogSchema.index({
  tenantId: 1,
  workflowId: 1,
  timestamp: -1,
});

// Per-user activity log
AutomationAuditLogSchema.index({
  tenantId: 1,
  userId: 1,
  timestamp: -1,
});

// Global audit feed
AutomationAuditLogSchema.index({ tenantId: 1, timestamp: -1 });

// TTL index — auto-delete after 365-day retention
AutomationAuditLogSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
