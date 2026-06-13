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
 * Example entry:
 *   "At 10:00, conversation X was assigned to Agent Y
 *    because algorithm 'capacity-based' selected them
 *    (open chats: 3/5, pool: [A, B, C])"
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

  @Prop({
    type: String,
    required: true,
    enum: ['round-robin', 'least-busy', 'capacity-based', 'manual', 'queue'],
  })
  strategy: string;

  /** Human-readable reason for the assignment decision */
  @Prop({ required: true })
  reason: string;

  /**
   * Snapshot of agent workload at the time of assignment.
   * e.g. { agentId: '...', openChats: 3, maxCapacity: 5 }
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

OmniAssignmentAuditLogSchema.index(
  { tenantId: 1, createdAt: -1 },
  { name: 'audit_log_timeline' },
);
OmniAssignmentAuditLogSchema.index(
  { tenantId: 1, assignedAgentId: 1, createdAt: -1 },
  { name: 'audit_by_agent' },
);
