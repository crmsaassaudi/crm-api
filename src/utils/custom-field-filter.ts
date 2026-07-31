import { escapeRegex } from './escape-regex';

export type CustomFieldDefinitions = Record<string, string>;
type CustomFieldRegistry = {
  getByModule: (
    module: string,
  ) => Promise<
    Array<{ internalKey: string; fieldType: string; isActive?: boolean }>
  >;
};

type FilterEntry = { id?: unknown; value?: unknown };

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const NUMBER_TYPES = new Set([
  'NUMBER',
  'DECIMAL',
  'CURRENCY',
  'PERCENTAGE',
  'SCORE',
]);
const DATE_TYPES = new Set(['DATE', 'DATETIME']);

export const parseFilterEntries = (raw: unknown): FilterEntry[] => {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.slice(0, 100) : [];
  } catch {
    return [];
  }
};

export const loadCustomFieldDefinitions = async (
  registry: CustomFieldRegistry | undefined,
  module: string,
  rawFilters: unknown,
): Promise<CustomFieldDefinitions | undefined> => {
  if (
    !registry ||
    !parseFilterEntries(rawFilters).some(
      (filter) =>
        typeof filter.id === 'string' && filter.id.startsWith('customFields.'),
    )
  ) {
    return undefined;
  }

  const fields = await registry.getByModule(module);
  return Object.fromEntries(
    fields
      .filter(
        (field) =>
          field.isActive !== false && KEY_PATTERN.test(field.internalKey),
      )
      .map((field) => [field.internalKey, field.fieldType]),
  );
};

/**
 * Applies only tenant-registered custom-field paths to a Mongo filter.
 * Arbitrary dotted paths and Mongo operator fragments are always rejected.
 */
export const applyRegisteredCustomFieldFilters = (
  where: Record<string, any>,
  rawFilters: unknown,
  definitions?: CustomFieldDefinitions,
): void => {
  if (!definitions) return;

  for (const filter of parseFilterEntries(rawFilters)) {
    if (typeof filter.id !== 'string') continue;
    if (!filter.id.startsWith('customFields.')) continue;

    const key = filter.id.slice('customFields.'.length);
    const fieldType = definitions[key];
    if (!fieldType || !KEY_PATTERN.test(key)) continue;
    if (
      filter.value === undefined ||
      filter.value === null ||
      filter.value === ''
    )
      continue;

    const path = `customFields.${key}`;
    const values = Array.isArray(filter.value)
      ? filter.value.slice(0, 100)
      : null;

    if (values) {
      where[path] = { $in: values.map((value) => coerce(fieldType, value)) };
      continue;
    }

    if (NUMBER_TYPES.has(fieldType) || fieldType === 'BOOLEAN') {
      const value = coerce(fieldType, filter.value);
      if (value !== undefined) where[path] = value;
      continue;
    }

    if (DATE_TYPES.has(fieldType)) {
      const start = new Date(String(filter.value));
      if (Number.isNaN(start.getTime())) continue;
      if (fieldType === 'DATE') {
        const end = new Date(start);
        end.setUTCDate(end.getUTCDate() + 1);
        where[path] = { $gte: start, $lt: end };
      } else {
        where[path] = start;
      }
      continue;
    }

    where[path] = {
      $regex: escapeRegex(String(filter.value)),
      $options: 'i',
    };
  }
};

const coerce = (fieldType: string, value: unknown): unknown => {
  if (NUMBER_TYPES.has(fieldType)) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  if (fieldType === 'BOOLEAN') {
    if (typeof value === 'boolean') return value;
    if (String(value).toLowerCase() === 'true') return true;
    if (String(value).toLowerCase() === 'false') return false;
    return undefined;
  }
  return value;
};
