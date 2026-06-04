import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { tenantFilterPlugin } from '../plugins/tenant-filter.plugin';

export type ImportJobDocument = HydratedDocument<ImportJobSchemaClass>;

/**
 * Generic import job schema shared by ALL import modules.
 *
 * The `entityType` field distinguishes between contacts, accounts, deals,
 * tickets, etc. All modules share the same `import_jobs` collection so
 * cross-module import history can be queried in one place.
 */
@Schema({
  timestamps: true,
  collection: 'import_jobs',
  toJSON: {
    virtuals: true,
    getters: true,
    transform: (_doc, ret: any) => {
      delete ret.__v;
      return ret;
    },
  },
})
export class ImportJobSchemaClass {
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

  /** Module identifier: 'contact', 'account', 'deal', 'ticket', etc. */
  @Prop({ required: true, index: true })
  entityType: string;

  @Prop({ required: true })
  fileName: string;

  @Prop({ required: true, enum: ['csv', 'xlsx'] })
  fileFormat: string;

  @Prop({ default: 0 })
  rowCount: number;

  @Prop({
    required: true,
    enum: ['queued', 'active', 'completed', 'failed'],
    default: 'queued',
    index: true,
  })
  status: string;

  @Prop({ required: true, index: true })
  bullJobId: string;

  @Prop({ default: false })
  dryRun: boolean;

  // ── Config snapshot ────────────────────────────────────────────────

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  mapping: Record<string, string>;

  @Prop({ type: MongooseSchema.Types.Mixed })
  deduplication?: {
    matchingFields: string[];
    policy: string;
  };

  @Prop({ default: false })
  triggerAutomations: boolean;

  // ── Result (populated on completion) ──────────────────────────────

  @Prop({ type: MongooseSchema.Types.Mixed })
  summary?: {
    total: number;
    inserted: number;
    updated: number;
    skipped: number;
    errors: number;
  };

  @Prop({ type: MongooseSchema.Types.Mixed })
  preview?: {
    wouldInsert: number;
    wouldUpdate: number;
    wouldSkip: number;
    validationErrors: number;
  };

  @Prop()
  reportUrl?: string;

  @Prop()
  failedReason?: string;

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

export const ImportJobSchema =
  SchemaFactory.createForClass(ImportJobSchemaClass);

ImportJobSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// List jobs newest-first per tenant + entity type
ImportJobSchema.index(
  { tenantId: 1, entityType: 1, createdAt: -1 },
  { name: 'tenant_entity_import_history' },
);

// Filter by status
ImportJobSchema.index(
  { tenantId: 1, entityType: 1, status: 1, createdAt: -1 },
  { name: 'tenant_entity_import_status' },
);

// TTL: auto-delete documents after 90 days
ImportJobSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60, name: 'import_job_ttl' },
);

// Lookup by BullMQ job ID (used by processor to update status)
ImportJobSchema.index(
  { bullJobId: 1 },
  { name: 'bull_job_lookup', unique: true },
);
