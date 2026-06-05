import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { tenantFilterPlugin } from '../plugins/tenant-filter.plugin';

export type ExportJobDocument = HydratedDocument<ExportJobSchemaClass>;

/**
 * Generic export job schema shared by ALL export modules.
 *
 * The `entityType` field distinguishes contacts/accounts/deals/tickets. All
 * modules share one `export_jobs` collection so cross-module export history can
 * be queried (and audited) in one place. The document doubles as the audit
 * record for a bulk-export action.
 */
@Schema({
  timestamps: true,
  collection: 'export_jobs',
  toJSON: {
    virtuals: true,
    getters: true,
    transform: (_doc, ret: any) => {
      delete ret.__v;
      return ret;
    },
  },
})
export class ExportJobSchemaClass {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
    index: true,
  })
  userId: string;

  /** Snapshot of the requester's masking group at enqueue time. */
  @Prop()
  userGroupId?: string;

  /** Module identifier: 'contact', 'account', 'deal', 'ticket', etc. */
  @Prop({ required: true, index: true })
  entityType: string;

  @Prop({ required: true, enum: ['csv', 'xlsx'] })
  format: string;

  @Prop({
    required: true,
    enum: ['queued', 'active', 'completed', 'failed', 'cancelled'],
    default: 'queued',
    index: true,
  })
  status: string;

  @Prop({ required: true, index: true })
  bullJobId: string;

  // ── Request snapshot (audit) ───────────────────────────────────────

  @Prop({ type: MongooseSchema.Types.Mixed })
  filterSnapshot?: Record<string, any>;

  @Prop({ type: [String] })
  selectedColumns?: string[];

  @Prop()
  ip?: string;

  @Prop()
  userAgent?: string;

  // ── Result (populated on completion) ──────────────────────────────

  @Prop({ default: 0 })
  recordCount: number;

  @Prop()
  downloadUrl?: string;

  /** When the download link / file expires (NOT the document TTL). */
  @Prop()
  fileExpiresAt?: Date;

  @Prop()
  failedReason?: string;

  @Prop()
  cancelledAt?: Date;

  // ── Progress (updated during processing) ──────────────────────────

  @Prop({ type: MongooseSchema.Types.Mixed })
  progress?: {
    processed: number;
    total: number | null;
    pct: number | null;
  };

  // ── Timestamps ────────────────────────────────────────────────────

  @Prop()
  startedAt?: Date;

  @Prop()
  completedAt?: Date;

  @Prop({ default: now })
  createdAt: Date;

  @Prop({ default: now })
  updatedAt: Date;
}

export const ExportJobSchema =
  SchemaFactory.createForClass(ExportJobSchemaClass);

ExportJobSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// List jobs newest-first per tenant + entity type
ExportJobSchema.index(
  { tenantId: 1, entityType: 1, createdAt: -1 },
  { name: 'tenant_entity_export_history' },
);

// Filter by status (used by cleanup cron to find stale active jobs)
ExportJobSchema.index(
  { tenantId: 1, entityType: 1, status: 1, createdAt: -1 },
  { name: 'tenant_entity_export_status' },
);

// Lookup by BullMQ job ID (used by processor to update status)
ExportJobSchema.index(
  { bullJobId: 1 },
  { name: 'bull_export_lookup', unique: true },
);

// Job-history TTL: auto-delete the document after 90 days. This is the HISTORY
// retention, NOT the file retention (files expire much sooner — see storage).
ExportJobSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60, name: 'export_job_ttl' },
);
