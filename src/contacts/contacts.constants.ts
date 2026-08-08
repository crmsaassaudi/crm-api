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
export const CONTACT_EXPORT_QUEUE = 'contact-export';
export const CONTACT_IMPORT_QUEUE = 'contact-import';

/** Batch size for stream-import bulkWrite. Balances memory vs round-trips. */
export const IMPORT_BATCH_SIZE = 1_000;
/** Max upload size for an import file (50 MB). */
export const IMPORT_MAX_FILE_BYTES = 50 * 1024 * 1024;
/**
 * Contact fields a CSV column may be mapped onto.
 *
 * Attribution (`sourceId`), consent (`emailOptIn`/`smsOptIn`) and segmentation
 * (`tags`, `lifecycleStageId`) are mappable because a migration that drops them
 * lands records nobody may lawfully email and nobody can segment.
 *
 * `customFields.<key>` is accepted in addition to this list, validated against
 * the tenant's registry — see ContactImportProcessor.mapRow.
 */
export const IMPORT_MAPPABLE_FIELDS = [
  'firstName',
  'lastName',
  'emails',
  'phones',
  'companyName',
  'title',
  'address',
  'city',
  'country',
  'role',
  'birthday',
  'externalId',
  'externalSource',
  'sourceId',
  'lifecycleStageId',
  'statusId',
  'tags',
  'emailOptIn',
  'smsOptIn',
  'whatsappOptIn',
  'doNotCall',
  'isVIP',
] as const;
export type ImportMappableField = (typeof IMPORT_MAPPABLE_FIELDS)[number];
/** Array-typed contact fields — import appends/splits on these. */
export const IMPORT_ARRAY_FIELDS: ReadonlySet<string> = new Set([
  'emails',
  'phones',
  'tags',
]);
/** Fields parsed as booleans from the loose spellings a spreadsheet contains. */
export const IMPORT_BOOLEAN_FIELDS: ReadonlySet<string> = new Set([
  'emailOptIn',
  'smsOptIn',
  'whatsappOptIn',
  'doNotCall',
  'isVIP',
]);
/** Fields whose CSV text is a lifecycle/source name resolved against settings. */
export const IMPORT_SETTING_REFERENCE_FIELDS: ReadonlySet<string> = new Set([
  'sourceId',
  'lifecycleStageId',
  'statusId',
]);
export const IMPORT_CUSTOM_FIELD_PREFIX = 'customFields.';

// Removed: EXPORT_MAX_RECORDS, UNMASK_TTL_SECONDS and XLSX_ROW_WARN_THRESHOLD.
//
// All three were left behind when contact export was generalised into `common/export`,
// which has its own quotas (queued-per-tenant, per-user-per-hour) and its own xlsx
// writer. None of them was read by anything. A constant named like a limit but enforced
// nowhere is worse than no constant: it reads as a guarantee the code does not make —
// `UNMASK_TTL_SECONDS = 30` in particular described a reveal window that has never
// existed, so anyone reasoning about PII exposure from this file was misled.
