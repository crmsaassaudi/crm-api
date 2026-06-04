/** BullMQ queue name for deal imports. */
export const DEAL_IMPORT_QUEUE = 'deal-import';

/** Batch size for stream-import bulkWrite. */
export const DEAL_IMPORT_BATCH_SIZE = 1_000;

/** Max upload size for an import file (50 MB). */
export const DEAL_IMPORT_MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Deal fields a CSV column may be mapped onto. */
export const DEAL_IMPORT_MAPPABLE_FIELDS = [
  'title',
  'name',
  'pipeline',
  'value',
  'currency',
  'accountName',
  'description',
  'closeDate',
  'lostReason',
  'tags',
  'probability',
  'stageId',
  'sourceId',
  'ownerId',
] as const;

export type DealImportMappableField =
  (typeof DEAL_IMPORT_MAPPABLE_FIELDS)[number];

/** Array-typed deal fields — import appends/splits on these. */
export const DEAL_IMPORT_ARRAY_FIELDS: ReadonlySet<string> = new Set(['tags']);
