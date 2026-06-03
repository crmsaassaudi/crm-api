export const DEFAULT_LIFECYCLE_STAGES = [
  'subscriber',
  'lead',
  'mql',
  'sql',
  'opportunity',
  'customer',
  'evangelist',
] as const;

export const MAX_BULK_TAG_SIZE = 500;
export const EXPORT_MAX_RECORDS = 5_000;
export const UNMASK_TTL_SECONDS = 30;
export const CONTACT_EXPORT_QUEUE = 'contact-export';
export const CONTACT_IMPORT_QUEUE = 'contact-import';

/** Batch size for stream-import bulkWrite. Balances memory vs round-trips. */
export const IMPORT_BATCH_SIZE = 1_000;
/** Max upload size for an import file (50 MB). */
export const IMPORT_MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Rows above which XLSX is discouraged in favour of CSV. */
export const XLSX_ROW_WARN_THRESHOLD = 50_000;
/** Contact fields a CSV column may be mapped onto. */
export const IMPORT_MAPPABLE_FIELDS = [
  'firstName',
  'lastName',
  'emails',
  'phones',
  'companyName',
  'title',
  'address',
  'role',
] as const;
export type ImportMappableField = (typeof IMPORT_MAPPABLE_FIELDS)[number];
/** Array-typed contact fields — import appends/splits on these. */
export const IMPORT_ARRAY_FIELDS: ReadonlySet<string> = new Set([
  'emails',
  'phones',
]);
