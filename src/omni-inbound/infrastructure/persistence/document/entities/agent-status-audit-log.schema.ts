import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type AgentStatusAuditLogDocument =
  HydratedDocument<AgentStatusAuditLogSchemaClass>;

/**
 * Records every agent intentStatus transition for KPI reporting.
 *
 * Each document = one status change event, e.g.:
 *   "Agent X went from 'available' to 'busy' at 14:30 (manual)"
 *
 * Work time reports aggregate these transitions to compute:
 *   - Total Available time per day
 *   - Total Busy/Away/Offline time per day
 *   - Number of status changes per day
 */
@Schema({
  collection: 'agent_status_audit_logs',
  timestamps: true,
})
export class AgentStatusAuditLogSchemaClass {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true, index: true })
  agentId: string;

  @Prop({ required: true })
  fromStatus: string;

  @Prop({ required: true })
  toStatus: string;

  /**
   * What caused this transition:
   *   - agent_manual: Agent clicked a status in the UI
   *   - system_grace_expired: Grace period expired → forced offline
   *   - system_disconnect: All connections lost
   *   - system_reconnect: Agent reconnected within grace period
   *   - system_connect: Fresh session started
   *   - system_auto_available: Auto-available on connect (tenant setting)
   */
  @Prop({ required: true })
  trigger: string;

  @Prop({ required: true, type: Date, index: true })
  timestamp: Date;

  @Prop({ type: Object })
  metadata?: Record<string, any>;
}

export const AgentStatusAuditLogSchema = SchemaFactory.createForClass(
  AgentStatusAuditLogSchemaClass,
);

// Compound index for efficient querying by tenant + agent + time range
AgentStatusAuditLogSchema.index({ tenantId: 1, agentId: 1, timestamp: -1 });

// Index for team-level reports (all agents for a tenant in a time range)
AgentStatusAuditLogSchema.index({ tenantId: 1, timestamp: -1 });

// F-12 fix: TTL index for automatic data retention (90 days).
// Prevents unbounded collection growth that would degrade KPI report
// query performance over time. Adjust TTL to match your compliance requirements.
AgentStatusAuditLogSchema.index(
  { timestamp: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 }, // 90 days
);
