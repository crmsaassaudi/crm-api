import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type ChannelConfigAuditDocument =
  HydratedDocument<ChannelConfigAuditSchemaClass>;

const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'set_default',
  'verify',
  'reconnect',
  'test_sync',
  'label_reconcile',
  'health_check',
] as const;

/**
 * Channel Config Audit Log -- captures every configuration change for compliance.
 *
 * Follows the AssignmentAuditLog pattern from omni-inbound module.
 *
 * WHO changed WHAT, WHEN, and from WHERE:
 *   - userId: who performed the action (from CLS/JWT context)
 *   - action: what happened (create, update, delete, set_default, verify)
 *   - configId + configName: which config was affected
 *   - changes: non-sensitive snapshot of what changed
 *   - ipAddress + userAgent: from where (request metadata)
 *
 * Retention: 90 days hot (MongoDB TTL), 1 year cold (S3 archive).
 * TTL index on createdAt automatically purges old entries.
 */
@Schema({
  timestamps: true,
  collection: 'channel_config_audit_logs',
  toJSON: { virtuals: true, getters: true },
})
export class ChannelConfigAuditSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  /** User who performed the action (from JWT/CLS context) */
  @Prop({
    type: String,
    required: true,
  })
  userId: string;

  /** The config that was affected */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    required: true,
    index: true,
  })
  configId: string;

  @Prop({
    type: String, required: true, enum: AUDIT_ACTIONS })
  action: string;

  /** Config name at time of action (preserved even after deletion) */
  @Prop({ required: true })
  configName: string;

  @Prop({ type: String, default: null })
  providerType: string | null;

  /**
   * Non-sensitive snapshot of changes.
   *
   * For 'create': { providerType, name, isDefault }
   * For 'update': { changedFields: ['name', 'publicSettings.fromEmail', 'credentials'] }
   *   Note: 'credentials' is listed as changed but value is NEVER included.
   * For 'delete': { reason?: string }
   * For 'set_default': { previousDefault?: string }
   * For 'verify': { result: 'success' | 'failure' }
   */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  changes: Record<string, any>;

  /** Client IP address (from x-forwarded-for or req.ip) */
  @Prop({ type: String, default: null })
  ipAddress: string | null;

  /** Client user agent string */
  @Prop({ type: String, default: null })
  userAgent: string | null;
}

export const ChannelConfigAuditSchema = SchemaFactory.createForClass(
  ChannelConfigAuditSchemaClass,
);

ChannelConfigAuditSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// Timeline: "show all changes for tenant in last 30 days"
ChannelConfigAuditSchema.index(
  { tenantId: 1, createdAt: -1 },
  { name: 'audit_timeline' },
);

// Per-config history: "who changed this config?"
ChannelConfigAuditSchema.index(
  { configId: 1, createdAt: -1 },
  { name: 'audit_per_config' },
);

// Retention: 90-day TTL (hot data). Cold archival to S3 handled separately.
ChannelConfigAuditSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60, name: 'audit_ttl_90d' },
);
