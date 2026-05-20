import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';

export type AuditLogSchemaDocument = HydratedDocument<AuditLogSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'audit_logs',
})
export class AuditLogSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    index: true,
    immutable: true,
  })
  tenantId?: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    index: true,
    immutable: true,
  })
  actorId?: string;

  @Prop({ required: true, index: true, immutable: true })
  action: string;

  @Prop({ required: true, index: true, immutable: true })
  targetEntityType: string;

  @Prop({ required: true, index: true, immutable: true })
  targetEntityId: string;

  @Prop({ default: now, index: true, immutable: true })
  timestamp: Date;

  @Prop({ immutable: true })
  ipAddress?: string;

  @Prop({ immutable: true })
  userAgent?: string;

  @Prop({ type: MongooseSchema.Types.Mixed, immutable: true })
  metadata?: Record<string, any>;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLogSchemaClass);

AuditLogSchema.index(
  { tenantId: 1, targetEntityType: 1, targetEntityId: 1, timestamp: -1 },
  { name: 'tenant_target_audit_lookup' },
);
AuditLogSchema.index(
  { tenantId: 1, actorId: 1, timestamp: -1 },
  { name: 'tenant_actor_audit_lookup' },
);
