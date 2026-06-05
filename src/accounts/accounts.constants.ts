/** BullMQ queue name for account imports. */
export const ACCOUNT_IMPORT_QUEUE = 'account-import';

/** BullMQ queue name for account exports. */
export const ACCOUNT_EXPORT_QUEUE = 'account-export';

/** Batch size for stream-import bulkWrite. Balances memory vs round-trips. */
export const ACCOUNT_IMPORT_BATCH_SIZE = 1_000;

/** Max upload size for an import file (50 MB). */
export const ACCOUNT_IMPORT_MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Account fields a CSV column may be mapped onto. */
export const ACCOUNT_IMPORT_MAPPABLE_FIELDS = [
  'name',
  'website',
  'industry',
  'emails',
  'phones',
  'taxId',
  'annualRevenue',
  'numberOfEmployees',
  'billingAddress',
  'shippingAddress',
  'tags',
] as const;

export type AccountImportMappableField =
  (typeof ACCOUNT_IMPORT_MAPPABLE_FIELDS)[number];

/** Array-typed account fields — import appends/splits on these. */
export const ACCOUNT_IMPORT_ARRAY_FIELDS: ReadonlySet<string> = new Set([
  'emails',
  'phones',
  'tags',
]);
