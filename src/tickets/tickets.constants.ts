/** BullMQ queue name for ticket imports. */
export const TICKET_IMPORT_QUEUE = 'ticket-import';

/** Batch size for stream-import bulkWrite. */
export const TICKET_IMPORT_BATCH_SIZE = 1_000;

/** Max upload size for an import file (50 MB). */
export const TICKET_IMPORT_MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Ticket fields a CSV column may be mapped onto. */
export const TICKET_IMPORT_MAPPABLE_FIELDS = [
  'subject',
  'description',
  'priority',
  'channel',
  'tags',
  'resolutionNotes',
  'typeId',
  'statusId',
  'sourceId',
  'ownerId',
  'groupId',
] as const;

export type TicketImportMappableField =
  (typeof TICKET_IMPORT_MAPPABLE_FIELDS)[number];

/** Array-typed ticket fields — import appends/splits on these. */
export const TICKET_IMPORT_ARRAY_FIELDS: ReadonlySet<string> = new Set([
  'tags',
]);
