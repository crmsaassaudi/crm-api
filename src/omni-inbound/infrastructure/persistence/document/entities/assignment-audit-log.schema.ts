import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type AssignmentAuditLogDocument =
  HydratedDocument<AssignmentAuditLogSchemaClass>;

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
  collection: 'assignment_audit_logs',
  toJSON: { virtuals: true, getters: true },
})
export class AssignmentAuditLogSchemaClass extends EntityDocumentHelper {
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

export const AssignmentAuditLogSchema = SchemaFactory.createForClass(
  AssignmentAuditLogSchemaClass,
);

AssignmentAuditLogSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

AssignmentAuditLogSchema.index(
  { tenantId: 1, createdAt: -1 },
  { name: 'audit_log_timeline' },
);
AssignmentAuditLogSchema.index(
  { tenantId: 1, assignedAgentId: 1, createdAt: -1 },
  { name: 'audit_by_agent' },
);
