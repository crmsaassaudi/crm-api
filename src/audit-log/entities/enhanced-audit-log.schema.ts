import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type EnhancedAuditLogDocument =
  HydratedDocument<EnhancedAuditLogSchemaClass>;

/**
 * Compressed audit log schema for granular field-level change tracking.
 *
 * Key abbreviations:
 *   t   = timestamp (of the original request, NOT worker processing time)
 *   src = execution source: M=Manual, A=API, A_F=Automation Flow, B=Bot, S=System
 *   ctx = source context (flowId, keyId, botId depending on src)
 *   f   = field key
 *   l   = label snapshot at time of change (resolves Custom Field Schema Drift)
 *   o   = old value
 *   n   = new value
 *
 * Storage: Writes to isolated DB connection 'audit-log-db-connection'
 * to avoid polluting main WiredTiger cache.
 */
@Schema({ timestamps: false, collection: 'enhanced_audit_logs' })
export class EnhancedAuditLogSchemaClass {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true }) // CONTACT | DEAL | TICKET
  entityType: string;

  @Prop({ required: true })
  entityId: string;

  /**
   * [PATCH P1] Timestamp of the original request — generated at CRM Service layer,
   * NOT at the worker. Prevents clock skew when queue backlogs.
   */
  @Prop({ required: true })
  t: Date;

  @Prop({ required: true })
  actorId: string;

  /**
   * Execution source:
   *   M   = Manual (UI/HTTP)
   *   A   = API Key
   *   A_F = Automation Flow
   *   B   = Bot
   *   S   = System (migration, script)
   */
  @Prop({ required: true, enum: ['M', 'A', 'A_F', 'B', 'S'] })
  src: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  ctx?: { flowId?: string; keyId?: string; botId?: string };

  @Prop()
  ip?: string;

  @Prop()
  ua?: string;

  /**
   * Field-level changes array. Each element tracks one field mutation.
   * _id: false prevents Mongoose from auto-generating ObjectIds per array element.
   *
   * [PATCH P3] `l` field stores the human-readable label at the time of change
   * to handle Custom Field schema drift (admin renaming/deleting fields later).
   *
   * [PATCH R3] Values are truncated by AuditDiffEngine if > 256 chars.
   */
  @Prop({
    type: [
      {
        _id: false,
        f: String,
        l: String,
        o: MongooseSchema.Types.Mixed,
        n: MongooseSchema.Types.Mixed,
      },
    ],
    required: true,
  })
  changes: Array<{ f: string; l?: string; o: any; n: any }>;
}

export const EnhancedAuditLogSchema = SchemaFactory.createForClass(
  EnhancedAuditLogSchemaClass,
);

/**
 * Composite cursor index for O(1) pagination.
 * Supports: getEnhancedAuditLogs(tenantId, entityType, entityId, cursor)
 * Sort: newest-first (t DESC, _id DESC).
 */
EnhancedAuditLogSchema.index(
  { tenantId: 1, entityType: 1, entityId: 1, t: -1, _id: -1 },
  { name: 'tenant_entity_cursor_lookup' },
);
