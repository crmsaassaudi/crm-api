/**
 * Redaction for anything that gets PERSISTED into an execution log.
 *
 * `automation_execution_logs` stored `input: { recordData: payload.data }` — the
 * complete CRM record, so names, emails, phones and every custom field of every
 * record any workflow ever touched sat in a collection readable with
 * `automation_logs:view` for 30 days. The orchestrator even carried a comment
 * describing a slimming policy ("Fields preserved when slimming a record before
 * it is queued / logged") whose field list was empty and which was never applied.
 *
 * The queue payload deliberately still carries the FULL record: executors need
 * arbitrary fields for template interpolation and recipient resolution, and that
 * payload is transient (Redis, bounded retention). Only the durable log is
 * slimmed.
 *
 * Safe to slim the persisted action config now that the manual-retry path
 * re-resolves it from the workflow's published snapshot instead of reading it
 * back out of the log.
 *
 * @see docs/audit/WORKFLOW_AUTOMATION_SECURITY_AUDIT.md — finding M1
 */

/**
 * Record fields kept in a persisted step. Identity and routing only — enough to
 * answer "which record, who owned it, what state was it in" without reproducing
 * the record. Deliberately excludes every free-text and contact field.
 */
const LOGGED_RECORD_FIELDS = [
  '_id',
  'id',
  'ownerId',
  'orgUnitId',
  'groupId',
  'statusId',
  'stageId',
  'typeId',
  'sourceId',
  'priority',
  'lifecycleStage',
  'isShadow',
  'ticketNumber',
  'channelType',
  'senderType',
  'status',
  'createdAt',
  'updatedAt',
] as const;

/** Config keys that carry credentials or bodies worth not persisting. */
const REDACTED_CONFIG_KEYS = [
  'headers',
  'encryptedHeaders',
  'apiKey',
  'apikey',
  'token',
  'secret',
  'password',
  'authorization',
  'bodyTemplate',
  'template',
  'message',
  'content',
  'params',
  'fieldMappings',
];

/** Longer string values are truncated rather than dropped. */
const MAX_LOGGED_STRING = 200;

export const REDACTED = '[redacted]';

/**
 * Reduce a CRM record to the identity/routing fields worth keeping in a log.
 *
 * Reports how many fields were dropped so a reader can tell the difference
 * between "the record was nearly empty" and "we did not store it".
 */
export function slimRecordForLog(
  record: unknown,
): Record<string, unknown> | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return undefined;
  }

  const source = record as Record<string, unknown>;
  const slim: Record<string, unknown> = {};

  for (const field of LOGGED_RECORD_FIELDS) {
    if (source[field] !== undefined) slim[field] = source[field];
  }

  const omitted = Object.keys(source).length - Object.keys(slim).length;
  if (omitted > 0) slim._fieldsOmitted = omitted;

  return slim;
}

/**
 * Strip credentials and free-text bodies from an action config before it is
 * persisted, and cap what remains.
 */
export function slimActionConfigForLog(
  config: unknown,
): Record<string, unknown> | undefined {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return undefined;
  }

  const source = config as Record<string, unknown>;
  const slim: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (REDACTED_CONFIG_KEYS.includes(key)) {
      slim[key] = REDACTED;
      continue;
    }
    slim[key] = truncate(value);
  }

  return slim;
}

/**
 * Redact an executor's `output` before it is persisted. Outputs routinely echo
 * the recipient back (`to: '+8490…'`, `to: 'a@b.com'`).
 */
export function slimOutputForLog(
  output: unknown,
): Record<string, unknown> | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return undefined;
  }

  const source = output as Record<string, unknown>;
  const slim: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === 'to' || key === 'recipientIds' || key === 'mergedTags') {
      // Keep the shape (did it resolve a recipient?) without the identifier.
      slim[key] = Array.isArray(value) ? `${value.length} value(s)` : REDACTED;
      continue;
    }
    slim[key] = truncate(value);
  }

  return slim;
}

function truncate(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.length > MAX_LOGGED_STRING
    ? `${value.slice(0, MAX_LOGGED_STRING)}… [truncated]`
    : value;
}
