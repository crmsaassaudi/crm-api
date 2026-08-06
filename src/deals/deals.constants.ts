import type { DealRules } from './deal-rules.service';

/** BullMQ queue name for deal imports. */
export const DEAL_IMPORT_QUEUE = 'deal-import';

/** BullMQ queue name for deal exports. */
export const DEAL_EXPORT_QUEUE = 'deal-export';

/** Redis channel the follow-up sweep publishes on; bridged by CrmRealtimeGateway. */
export const DEAL_FOLLOW_UP_CHANNEL = 'socket:deal:follow-up:due';

/** Max number of deals allowed in a single bulk-tag request. */
export const DEAL_MAX_BULK_TAG_SIZE = 500;

/** Max number of deals allowed in a single bulk update/delete request. */
export const DEAL_BULK_MAX_IDS = 500;

/** Transitions kept on a deal. Older moves stay in the audit log. */
export const DEAL_STAGE_HISTORY_LIMIT = 100;

/** Batch size for stream-import bulkWrite. */
export const DEAL_IMPORT_BATCH_SIZE = 1_000;

/** Max upload size for an import file (50 MB). */
export const DEAL_IMPORT_MAX_FILE_BYTES = 50 * 1024 * 1024;

/** crm_settings key holding the tenant's deal rules. */
export const DEAL_RULES_SETTING_KEY = 'deal_rules';

/**
 * Defaults require only what a revenue figure cannot be trusted without. Contact
 * and close date are opt-in: an SMB selling over the counter often has neither,
 * and a rule nobody can satisfy is a rule everybody works around.
 */
export const DEFAULT_DEAL_RULES: DealRules = {
  requireValueOnWin: true,
  requireOwnerOnWin: true,
  requireContactOnWin: false,
  requireCloseDateOnWin: false,
  followUpDefaultOffsetHours: 24,
  followUpEscalationHours: 24,
};

/** Deal fields a CSV column may be mapped onto. */
export const DEAL_IMPORT_MAPPABLE_FIELDS = [
  'title',
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
  'utmSource',
  'utmMedium',
  'utmCampaign',
] as const;

export type DealImportMappableField =
  (typeof DEAL_IMPORT_MAPPABLE_FIELDS)[number];

/** Array-typed deal fields — import appends/splits on these. */
export const DEAL_IMPORT_ARRAY_FIELDS: ReadonlySet<string> = new Set(['tags']);
