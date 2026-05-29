import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type ChannelConfigSchemaDocument =
  HydratedDocument<ChannelConfigSchemaClass>;

const PROVIDER_TYPES = ['sendgrid', 'smtp', 'twilio'] as const;
const CONFIG_STATUSES = ['active', 'error', 'disabled'] as const;
const HEALTH_STATES = ['healthy', 'degraded', 'unhealthy'] as const;
const AUTH_TYPES = ['app_password', 'oauth2'] as const;

@Schema({
  timestamps: true,
  collection: 'tenant_channel_configs',
  toJSON: { virtuals: true, getters: true },
})
export class ChannelConfigSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({
    type: String, required: true, enum: PROVIDER_TYPES })
  providerType: string;

  @Prop({ type: Number, default: 1 })
  schemaVersion: number;

  @Prop({ required: true })
  name: string;

  @Prop({ default: false })
  isDefault: boolean;

  /**
   * AES-256-GCM encrypted JSON blob.
   * Format: iv:authTag:ciphertext (all base64).
   * NEVER returned in list API — use select: false.
   */
  @Prop({ type: String, select: false })
  encryptedCredentials?: string;

  @Prop({ type: String, enum: AUTH_TYPES, default: 'app_password' })
  authType: string;

  @Prop({ type: String, select: false, default: null })
  accessToken: string | null;

  @Prop({ type: String, select: false, default: null })
  refreshToken: string | null;

  @Prop({ type: Date, default: null })
  tokenExpiresAt: Date | null;

  /**
   * Non-sensitive settings (fromEmail, fromName, fromNumber).
   * Safe to return in API responses.
   */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  publicSettings: Record<string, any>;

  @Prop({
    type: String,
    required: true,
    enum: CONFIG_STATUSES,
    default: 'active',
  })
  status: string;

  /**
   * Soft-delete marker. null = active, Date = soft-deleted.
   */
  @Prop({ type: Date, default: null })
  deletedAt: Date | null;

  // ── Health Check Metadata (Phase 2) ─────────────────────────────────

  /**
   * Last time this config was verified successfully (by Health Check or manual verify).
   */
  @Prop({ type: Date, default: null })
  lastVerifiedAt: Date | null;

  /**
   * Error message from the last failed health check. null = healthy.
   */
  @Prop({ type: String, default: null })
  lastHealthError: string | null;

  /**
   * Consecutive health check failures. Reset to 0 on success.
   * Config status set to 'error' when this reaches threshold (≥2).
   */
  @Prop({ type: Number, default: 0 })
  consecutiveFailures: number;

  // ── Adaptive Health Check (Phase 3) ──────────────────────────────────

  /**
   * Internal health state for adaptive check scheduling.
   * Separate from `status` (user-facing).
   *   - healthy: normal 6-hour cron
   *   - degraded: 1 failure — 5-minute re-check
   *   - unhealthy: 2+ failures — exponential backoff (15m → 1h → 6h)
   */
  @Prop({ type: String, enum: HEALTH_STATES, default: 'healthy' })
  healthState: string;

  /**
   * Scheduled time for the next adaptive health check.
   * Set dynamically based on healthState + consecutiveFailures.
   * null = use default 6-hour cron (healthy configs).
   */
  @Prop({ type: Date, default: null })
  nextHealthCheckAt: Date | null;
}

export const ChannelConfigSchema = SchemaFactory.createForClass(
  ChannelConfigSchemaClass,
);

ChannelConfigSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// Unique name per tenant+provider (only for non-deleted configs)
ChannelConfigSchema.index(
  { tenantId: 1, providerType: 1, name: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: null },
  },
);

// Fast lookup: all active configs for a tenant
ChannelConfigSchema.index({ tenantId: 1, deletedAt: 1, providerType: 1 });

// Adaptive health check: sparse index for efficient per-minute query
// Most configs have nextHealthCheckAt=null (healthy), so sparse saves space
ChannelConfigSchema.index(
  { nextHealthCheckAt: 1, deletedAt: 1, status: 1 },
  { sparse: true },
);
