/**
 * Standardized import error codes shared by all import modules.
 *
 * Convention: every error appended to an import report MUST carry one of these
 * codes so the frontend/report/i18n layer can render it without parsing free-text.
 */
export enum ImportErrorCode {
  /** A schema-required field (e.g. firstName, title) is missing in the row. */
  REQUIRED_FIELD_MISSING = 'required_field_missing',
  /** An email value failed RFC-5322-ish validation. */
  INVALID_EMAIL = 'invalid_email',
  /** A phone value failed E.164-ish validation. */
  INVALID_PHONE = 'invalid_phone',
  /** Dedup found an existing record in the database matching this row. */
  DUPLICATE_FOUND = 'duplicate_found',
  /** Within-file dedup: another earlier row in the same file already claimed this key. */
  DUPLICATE_IN_FILE = 'duplicate_in_file',
  /** A reference field (stageId, typeId, etc.) resolved to zero records. */
  REFERENCE_NOT_FOUND = 'reference_not_found',
  /** A reference field resolved to multiple records — ambiguous. */
  REFERENCE_AMBIGUOUS = 'reference_ambiguous',
  /** The user lacks permission to perform this import operation. */
  PERMISSION_DENIED = 'permission_denied',
  /** A value failed a module-specific validation rule. */
  VALIDATION_FAILED = 'validation_failed',
  /** MongoDB bulkWrite rejected this document. */
  DB_WRITE_FAILED = 'db_write_failed',
  /** Merge produced no changes — the existing record already has all incoming data. */
  MERGE_NO_CHANGE = 'merge_no_change',
  /** A conflict was detected during merge (e.g. multiple emails disabled). */
  MERGE_CONFLICT = 'merge_conflict',
}

/**
 * A single error or warning associated with one source row.
 *
 * Errors are streamed to NDJSON during processing (never accumulated in RAM)
 * and assembled into the final JSON report on finalization.
 */
export interface ImportRowError {
  /** 1-based row number in the source file. */
  row: number;
  /** The error code for programmatic handling. */
  code: ImportErrorCode;
  /** The field that caused the error, if applicable. */
  field?: string;
  /** Human-readable explanation (English; i18n is handled by the frontend). */
  reason: string;
  /** The offending value, truncated to 200 chars for report readability. */
  value?: string;
}
