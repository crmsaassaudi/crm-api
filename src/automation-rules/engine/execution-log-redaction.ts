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
