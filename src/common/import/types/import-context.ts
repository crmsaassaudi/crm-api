import { TenantJobData } from '../../../queue/base-tenant.consumer';

/** How the import engine should handle a matched duplicate. */
export type DedupPolicy = 'skip' | 'overwrite' | 'merge' | 'create_new';

/**
 * Base job data interface for ALL import jobs across every module.
 * Module-specific processors extend this with their own fields.
 *
 * Convention: every import queue job MUST include these fields.
 */
export interface BaseImportJobData extends TenantJobData {
  /** Storage key returned by the upload endpoint. */
  fileKey: string;
  /** Source-column → entity-field mapping chosen by the user. */
  mapping: Record<string, string>;
  /** Dedup configuration (optional — some modules never dedup). */
  deduplication?: {
    matchingFields: string[];
    policy: DedupPolicy;
  };
  /** When true, parse+validate+dedup but never write to DB. */
  dryRun?: boolean;
  /** When true, emit automation events after each batch write. */
  triggerAutomations?: boolean;
  /** When true, emit webhook events after import. */
  triggerWebhooks?: boolean;
  /** When true, create activity log entries for imported records. */
  createActivityLogs?: boolean;
  /** Client-side row estimate (excluding header) for accurate progress %. */
  estimatedRows?: number;
  /** Original file name for display in import history. */
  fileName?: string;
  /** Module-specific tenant settings snapshot, serialized at enqueue time. */
  tenantSettings?: Record<string, any>;
  /**
   * Record owner for every row this job writes. Captured at enqueue time from
   * the requesting user (or an explicit override) because the worker writes via
   * `bulkWrite`, which bypasses the repository's CLS-driven ownership stamping.
   * Unowned records are hidden from scoped users, so an import that omits this
   * is invisible to everyone but an admin.
   */
  ownerId?: string;
  /** Org unit for every row this job writes; same rationale as `ownerId`. */
  orgUnitId?: string;
}

/**
 * A single source row mapped onto entity fields, ready for dedup and write.
 * Module processors emit these from their `mapRow()` implementation.
 */
export interface MappedRow {
  /** 1-based row number in the source file. */
  row: number;
  /** Scalar field values (key = entity field name, value = string). */
  fields: Record<string, any>;
  /** Array-typed field values (key = entity field name, value = string[]). */
  arrayFields: Record<string, string[]>;
}

/**
 * Progress state reported by the import processor.
 */
export interface ImportProgress {
  processed: number;
  total: number | null;
  pct: number | null;
}
