/** BullMQ queue name for ticket imports. */
export const TICKET_IMPORT_QUEUE = 'ticket-import';

/** BullMQ queue name for ticket exports. */
export const TICKET_EXPORT_QUEUE = 'ticket-export';

/** Max number of tickets allowed in a single bulk-tag request. */
export const TICKET_MAX_BULK_TAG_SIZE = 500;

/** Deepest `categoryPath` accepted, matching the depth the settings UI builds. */
export const TICKET_MAX_CATEGORY_DEPTH = 5;

/** Batch size for stream-import bulkWrite. */
export const TICKET_IMPORT_BATCH_SIZE = 1_000;

/** Max upload size for an import file (50 MB). */
export const TICKET_IMPORT_MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Ticket fields a CSV column may be mapped onto.
 *
 * `ticketNumber` and `contactId` are here because the import is otherwise
 * unusable for the job it exists for: migrating an existing helpdesk. Without
 * `contactId` every imported ticket lands with no customer, and without
 * `ticketNumber` the dedup policies have no natural key to match on, so
 * re-running an import duplicates the whole file.
 */
export const TICKET_IMPORT_MAPPABLE_FIELDS = [
  'subject',
  'description',
  'priority',
  'channel',
  'tags',
  'resolutionNotes',
  'ticketNumber',
  'typeId',
  'statusId',
  'sourceId',
  'ownerId',
  'groupId',
  'contactId',
] as const;

export type TicketImportMappableField =
  (typeof TICKET_IMPORT_MAPPABLE_FIELDS)[number];

/** Array-typed ticket fields — import appends/splits on these. */
export const TICKET_IMPORT_ARRAY_FIELDS: ReadonlySet<string> = new Set([
  'tags',
]);
