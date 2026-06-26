import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type OmniAssignmentAuditLogDocument =
  HydratedDocument<OmniAssignmentAuditLogSchemaClass>;

/**
 * Audit log for every assignment decision.
 *
 * Records WHY a conversation was assigned to a specific agent,
 * which algorithm was used, and the state at the time of assignment.
 *
 * T05 update: added top-level typed fields (previousAgentId, ruleId, channelType,
 * agentPoolSize) that were previously buried in the freeform metadata blob.
 * These fields are indexed for efficient routing analytics queries.
 */
@Schema({
  timestamps: true,
  // Dedicated collection. The CRM-entity assignment engine
  // (src/assignment-engine) has its OWN AssignmentAuditLog with an
  // incompatible shape (module/entityId). Sharing a collection — and, worse,
  // a Mongoose model name — caused omni audit writes to be validated against
  // the engine schema and silently dropped. Keep them fully separate.
  collection: 'omni_assignment_audit_logs',
  toJSON: { virtuals: true, getters: true },
})
export class OmniAssignmentAuditLogSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'OmniConversationSchemaClass',
    required: true,
    index: true,
  })
  conversationId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    default: null,
  })
  assignedAgentId: string | null;

  /**
   * T05: the agent who was assigned BEFORE this decision.
   * Null for first-time assignments. Populated for reassignments and fallback re-routes.
   * Enables reassignment chain queries without joining the activity log.
   */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    default: null,
  })
  previousAgentId: string | null;

  /**
   * T05: the routing rule that matched and drove this assignment, if any.
   * Null when assignment was driven by the default strategy (no rule match).
   */
  @Prop({ type: String, default: null })
  ruleId: string | null;

  /** T05: human-readable name of the matched routing rule for display in dashboards. */
  @Prop({ type: String, default: null })
  ruleName: string | null;

  /** T05: channel type (whatsapp, facebook, livechat, etc.) for per-channel analytics. */
  @Prop({ type: String, default: null })
  channelType: string | null;

  /** T05: total size of the agent pool evaluated before skills filtering. */
  @Prop({ type: Number, default: 0 })
  agentPoolSize: number;

  /** T05: size of the pool after skills filtering (may be smaller than agentPoolSize). */
  @Prop({ type: Number, default: 0 })
  eligiblePoolSize: number;

  @Prop({
    type: String,
    required: true,
    enum: [
      'round-robin',
      'least-busy',
      'capacity-based',
      'sticky',
      'manual',
      'queue',
      'reply_auto_assign',
    ],
  })
  strategy: string;

  /** Human-readable reason for the assignment decision (kept for legacy data) */
  @Prop({ required: true })
  reason: string;

  /**
   * i18n key for the reason — used by the frontend to translate the reason.
   * Format: camelCase key matching routingTrace.reason.<key> in the locale files.
   * e.g. 'noAgentsQueued', 'stickyWait', 'manualUnassigned'
   * Null for legacy entries that predate this field.
   */
  @Prop({ type: String, default: null })
  reasonKey: string | null;

  /**
   * Dynamic interpolation params for the reasonKey translation.
   * e.g. { minutes: 30 } for stickyWait
   * Null when the reason has no dynamic parts.
   */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  reasonParams: Record<string, any> | null;

  /**
   * Snapshot of agent workload at the time of assignment.
   * e.g. { agentId: '...', openChats: 3, maxCapacity: 5 }
   * Note: structured data should prefer top-level Prop fields (see T05 above).
   */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  metadata: Record<string, any>;

  /** Whether the assignment was successful or the conversation went to queue */
  @Prop({
    type: String,
    required: true,
    enum: ['assigned', 'queued', 'failed'],
  })
  outcome: string;
}

export const OmniAssignmentAuditLogSchema = SchemaFactory.createForClass(
  OmniAssignmentAuditLogSchemaClass,
);

OmniAssignmentAuditLogSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// Core timeline index
OmniAssignmentAuditLogSchema.index(
  { tenantId: 1, createdAt: -1 },
  { name: 'audit_log_timeline' },
);
// Per-agent routing history (existing)
OmniAssignmentAuditLogSchema.index(
  { tenantId: 1, assignedAgentId: 1, createdAt: -1 },
  { name: 'audit_by_agent' },
);
// Per-conversation routing chain (existing)
OmniAssignmentAuditLogSchema.index(
  { tenantId: 1, conversationId: 1, createdAt: 1 },
  { name: 'audit_by_conversation' },
);
// T05: routing rule analytics — "all assignments driven by rule X"
OmniAssignmentAuditLogSchema.index(
  { tenantId: 1, ruleId: 1, createdAt: -1 },
  { name: 'audit_by_rule', sparse: true },
);
// T05: per-channel routing analytics — "all assignments for whatsapp last 7 days"
OmniAssignmentAuditLogSchema.index(
  { tenantId: 1, channelType: 1, createdAt: -1 },
  { name: 'audit_by_channel', sparse: true },
);
// T05: reassignment chain tracing — "who did this agent reassign from?"
OmniAssignmentAuditLogSchema.index(
  { tenantId: 1, previousAgentId: 1, createdAt: -1 },
  { name: 'audit_by_previous_agent', sparse: true },
);

// F-12 fix: TTL index for automatic data retention (30 days).
// Assignment audit logs are high-volume (one per routing decision).
// Older logs can be moved to a cold archive if compliance requires longer retention.
OmniAssignmentAuditLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60, name: 'audit_log_ttl_30d' }, // 30 days
);
