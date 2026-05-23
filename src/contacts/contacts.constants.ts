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
