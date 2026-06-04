/**
 * Aggregate summary of an import job — used in both real and dry-run modes.
 * Stored in the import_job MongoDB document and returned to the client.
 */
export interface ImportSummary {
  /** Total rows processed (including errors). */
  total: number;
  /** Rows that resulted in a new DB insert. */
  inserted: number;
  /** Rows that resulted in an update to an existing record. */
  updated: number;
  /** Rows skipped due to dedup policy or merge-no-change. */
  skipped: number;
  /** Rows that produced at least one error (validation, reference, DB). */
  errors: number;
}

/**
 * Dry-run preview: the counts that WOULD result if the import were executed.
 * No DB mutations occur during dry-run.
 */
export interface ImportPreview {
  wouldInsert: number;
  wouldUpdate: number;
  wouldSkip: number;
  validationErrors: number;
}

/**
 * The return value of any import processor's `handle()` method.
 */
export interface ImportResult {
  /** BullMQ job ID. */
  jobId: string;
  /** Whether this was a dry-run execution. */
  dryRun: boolean;
  /** Real-import summary (null for dry-run). */
  summary?: ImportSummary;
  /** Dry-run preview (null for real import). */
  preview?: ImportPreview;
  /** Download URL for the error/skip report (null when zero errors). */
  reportUrl?: string;
}
