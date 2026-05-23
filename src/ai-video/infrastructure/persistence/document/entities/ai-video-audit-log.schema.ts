import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';

export type AiVideoAuditLogSchemaDocument =
  HydratedDocument<AiVideoAuditLogSchemaClass>;

/**
 * Immutable audit trail for every state transition and significant action
 * within the AI Video pipeline.
 *
 * Actions include: VIDEO_CREATED, INGESTING, INGESTED, NORMALIZING,
 * NORMALIZED, PROCESSING, PROCESSED, PENDING_REVIEW, APPROVED, REJECTED, etc.
 */
@Schema({
  timestamps: true,
  collection: 'ai_video_audit_logs',
})
export class AiVideoAuditLogSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
    immutable: true,
  })
  tenantId: MongooseSchema.Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'AiVideoJobSchemaClass',
    required: true,
    index: true,
    immutable: true,
  })
  jobId: MongooseSchema.Types.ObjectId;

  @Prop({ type: String, required: true, immutable: true })
  action: string;

  @Prop({
    type: String,
    enum: ['user', 'system', 'worker', 'ai'],
    required: true,
    immutable: true,
  })
  actorType: 'user' | 'system' | 'worker' | 'ai';

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    immutable: true,
  })
  actorId?: MongooseSchema.Types.ObjectId;

  @Prop({ type: String, immutable: true })
  oldStatus?: string;

  @Prop({ type: String, immutable: true })
  newStatus?: string;

  @Prop({ type: MongooseSchema.Types.Mixed, immutable: true })
  payload?: Record<string, any>;

  @Prop({ type: String, immutable: true })
  errorMessage?: string;
}

export const AiVideoAuditLogSchema = SchemaFactory.createForClass(
  AiVideoAuditLogSchemaClass,
);

AiVideoAuditLogSchema.index(
  { tenantId: 1, jobId: 1, createdAt: -1 },
  { name: 'tenant_job_audit_timeline' },
);
