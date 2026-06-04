import { DedupPolicy } from './import-context';

/**
 * A reference field that must be resolved from text → ObjectId during import.
 * The shared reference resolver uses this config to batch-lookup target collections.
 */
export interface ImportReferenceField {
  /** Entity field name where the resolved ObjectId will be stored (e.g. 'stageId'). */
  entityField: string;
  /** The MongoDB collection to query against. */
  collection: string;
  /** Fields to match the text value against, in priority order. */
  lookupFields: string[];
  /** Whether to restrict the lookup to the current tenant. */
  tenantScoped: boolean;
  /** If true, the reference is required — missing → row error. */
  required: boolean;
  /** A default value (ObjectId or apiName) when the field is not mapped. */
  defaultValue?: string;
}

/**
 * Central contract defining how a module's import should behave.
 *
 * Each module provides ONE static config that drives the shared engine:
 *   - Parser: which fields to accept from the file
 *   - Dedup: which matching fields and policies are valid
 *   - References: which fields need text → ObjectId resolution
 *   - Validation: which fields are required
 *
 * The shared engine (BaseImportProcessor, ImportWizard, etc.) reads this config
 * and never hard-codes module-specific business logic.
 */
export interface ImportModuleConfig {
  /** Module identifier — used in queue names, Redis channels, storage prefixes. */
  module: string;

  /** Display name for UI/logging. */
  displayName: string;

  /** Entity fields that a CSV column may be mapped onto. */
  mappableFields: readonly string[];

  /** Fields that must be present in every row (schema-level required:true). */
  requiredFields: readonly string[];

  /** Fields that hold array values (emails, phones, tags, etc.). */
  arrayFields: ReadonlySet<string>;

  /** Valid dedup matching fields for this module. */
  dedupMatchingFields: readonly string[];

  /** Valid dedup policies for this module. */
  dedupPolicies: readonly DedupPolicy[];

  /** Reference fields that need text → ObjectId resolution. */
  referenceFields: readonly ImportReferenceField[];

  /** Batch size for bulkWrite. Default: 1000. */
  batchSize: number;

  /** Maximum upload file size in bytes. Default: 50MB. */
  maxFileBytes: number;

  /** Whether dry-run mode is available. */
  allowDryRun: boolean;

  /** Whether automation trigger is available. */
  allowAutomations: boolean;

  /** Redis pub/sub channel for completion events. */
  completionChannel: string;

  /** BullMQ queue name. */
  queueName: string;
}
