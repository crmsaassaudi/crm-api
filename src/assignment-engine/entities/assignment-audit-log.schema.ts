import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type AssignmentAuditLogDocument =
  HydratedDocument<AssignmentAuditLogSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'assignment_audit_logs',
  toJSON: { virtuals: true, getters: true },
})
export class AssignmentAuditLogSchemaClass {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true, enum: ['Contact', 'Ticket', 'Task', 'Deal'] })
  module: string;

  @Prop({ required: true })
  entityId: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  assignedUserId?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  previousOwnerId?: string;

  @Prop()
  ruleId?: string;

  @Prop()
  ruleName?: string;

  @Prop({ required: true })
  strategy: string;

  @Prop({ required: true })
  reason: string;

  @Prop({ default: 0 })
  candidatesEvaluated: number;

  @Prop({ default: 0 })
  candidatesFiltered: number;

  @Prop({ default: false })
  isFallback: boolean;

  @Prop({ default: false })
  isReassignment: boolean;

  @Prop()
  triggerField?: string;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  metadata: Record<string, any>;
}

export const AssignmentAuditLogSchema = SchemaFactory.createForClass(
  AssignmentAuditLogSchemaClass,
);
AssignmentAuditLogSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// TTL Index — auto-delete after 90 days (7,776,000 seconds)
AssignmentAuditLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 7776000 },
);
AssignmentAuditLogSchema.index({ tenantId: 1, module: 1, entityId: 1 });
