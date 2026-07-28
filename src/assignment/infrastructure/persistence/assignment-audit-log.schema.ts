import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../common/plugins/tenant-filter.plugin';
import {
  ASSIGNMENT_OBJECT_TYPES,
  ASSIGNMENT_OUTCOMES,
  ASSIGNMENT_SOURCES,
} from '../../domain/assignment.types';

export type AssignmentAuditLogDocument =
  HydratedDocument<AssignmentAuditLogSchemaClass>;

/**
 * One audit trail for every assignment decision, of any objectType.
 *
 * Replaces `assignment_audit_logs` (records: module/entityId/assignedUserId,
 * free-text reason only) and `omni_assignment_audit_logs` (conversations:
 * conversationId/assignedAgentId, reasonKey + outcome). The omni shape was the
 * richer of the two and already had a UI, so this is that shape generalised:
 * `conversationId → entityId`, `assignedAgentId → assigneeId`, plus `objectType`
 * and `source`.
 *
 * `strategy` is a free string rather than an enum: it records what actually
 * happened, including non-strategy paths ('manual', 'direct', 'fallback',
 * 'preferred', 'reply_auto_assign'), and an enum here has historically caused
 * silent write failures when a new path was added.
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

  @Prop({ type: String, required: true, enum: ASSIGNMENT_OBJECT_TYPES })
  objectType: string;

  /**
   * The record that was assigned. Stored as a string, not an ObjectId: a
   * pre-create decision has no id yet ('pre-create'), and a dry run has none at
   * all.
   */
  @Prop({ type: String, required: true, index: true })
  entityId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    default: null,
  })
  assigneeId: string | null;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    default: null,
  })
  previousAssigneeId: string | null;

  /** Team the record was filed under — set even when there is no assignee. */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'GroupSchemaClass',
    default: null,
  })
  groupId: string | null;

  @Prop({ type: String, default: null })
  ruleId: string | null;

  @Prop({ type: String, default: null })
  ruleName: string | null;

  @Prop({ type: String, required: true })
  strategy: string;

  @Prop({ type: String, required: true, enum: ASSIGNMENT_OUTCOMES })
  outcome: string;

  /** Human-readable fallback for logs and legacy rows. */
  @Prop({ required: true })
  reason: string;

  /** i18n key — the frontend renders `assignment.reason.<key>`. */
  @Prop({ type: String, default: null })
  reasonKey: string | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  reasonParams: Record<string, any> | null;

  @Prop({ type: String, enum: ASSIGNMENT_SOURCES, default: 'system' })
  source: string;

  /** Workflow that triggered this, when the source is an automation. */
  @Prop({ type: String, default: null })
  sourceWorkflowId: string | null;

  /** Actor for a manual (re)assignment. */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    default: null,
  })
  performedByUserId: string | null;

  /** Channel type for per-channel analytics (conversations only). */
  @Prop({ type: String, default: null })
  channelType: string | null;

  /** Pool size before filtering. */
  @Prop({ type: Number, default: 0 })
  candidatePoolSize: number;

  /** Pool size after capacity/skill/presence filtering. */
  @Prop({ type: Number, default: 0 })
  eligiblePoolSize: number;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  metadata: Record<string, any>;

  /** Set only after the immutable archive copy commits successfully. */
  @Prop({ type: Date, default: null })
  archivedAt: Date | null;
}

export const AssignmentAuditLogSchema = SchemaFactory.createForClass(
  AssignmentAuditLogSchemaClass,
);

AssignmentAuditLogSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// Global history page.
AssignmentAuditLogSchema.index(
  { tenantId: 1, createdAt: -1 },
  { name: 'assignment_audit_timeline' },
);
// "Why does this record have this owner?" — the question neither old table
// could answer across objectTypes.
AssignmentAuditLogSchema.index(
  { tenantId: 1, objectType: 1, entityId: 1, createdAt: 1 },
  { name: 'assignment_audit_by_entity' },
);
AssignmentAuditLogSchema.index(
  { tenantId: 1, assigneeId: 1, createdAt: -1 },
  { name: 'assignment_audit_by_assignee' },
);
AssignmentAuditLogSchema.index(
  { tenantId: 1, ruleId: 1, createdAt: -1 },
  { name: 'assignment_audit_by_rule', sparse: true },
);
AssignmentAuditLogSchema.index(
  { tenantId: 1, channelType: 1, createdAt: -1 },
  { name: 'assignment_audit_by_channel', sparse: true },
);
AssignmentAuditLogSchema.index(
  { tenantId: 1, previousAssigneeId: 1, createdAt: -1 },
  { name: 'assignment_audit_by_previous', sparse: true },
);

// Retention: 90 days. The two old tables disagreed (30d for conversations,
// 90d for records), which meant the same question had two different answers
// depending on what was assigned.
AssignmentAuditLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60, name: 'assignment_audit_ttl_90d' },
);
AssignmentAuditLogSchema.index(
  { archivedAt: 1, createdAt: 1 },
  { name: 'assignment_audit_archive_due' },
);
