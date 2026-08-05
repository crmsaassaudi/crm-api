/**
 * The one list of field types in the product.
 *
 * It used to exist only as `case` labels inside `CustomFieldValueValidator.coerce`
 * and as free-form strings in the `custom_fields` documents, which is why a typo
 * in a POST body produced a field the validator silently stored unchecked. Naming
 * the set lets the DTO reject an unknown type at the edge, and lets the standard
 * field registry describe built-in fields in the same vocabulary as custom ones —
 * so a layout, a validation rule or a masking policy does not need to know whether
 * the field it points at is standard or custom.
 */
export const FIELD_TYPES = [
  'TEXT',
  'TEXTAREA',
  'EMAIL',
  'PHONE',
  'URL',
  'ENCRYPTED',
  'NUMBER',
  'DECIMAL',
  'CURRENCY',
  'PERCENTAGE',
  'SCORE',
  'BOOLEAN',
  'DATE',
  'DATETIME',
  'TIME',
  'SINGLE_SELECT',
  'RADIO',
  'MULTI_SELECT',
  'CHECKBOX_GROUP',
  'USER_REFERENCE',
  'TEAM_REFERENCE',
  'RELATION',
  'MULTI_LOOKUP',
  'JSON',
  'FORMULA',
  'FILE_UPLOAD',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

const FIELD_TYPE_SET: ReadonlySet<string> = new Set(FIELD_TYPES);

export const isFieldType = (value: unknown): value is FieldType =>
  typeof value === 'string' && FIELD_TYPE_SET.has(value);

/**
 * Types whose stored value is a string (or an array of strings), and therefore
 * the only types a masking rule can act on.
 *
 * `FieldPolicyInterceptor` rewrites `string` and `string[]` values and leaves
 * everything else untouched. Offering a masking dropdown on a NUMBER or a DATE
 * produced a setting that saved, displayed as active, and did nothing — so the
 * registry marks which fields can actually be masked and the UI only offers it
 * there.
 */
const MASKABLE_FIELD_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  'TEXT',
  'TEXTAREA',
  'EMAIL',
  'PHONE',
  'URL',
  'ENCRYPTED',
  'SINGLE_SELECT',
  'RADIO',
  'MULTI_SELECT',
  'CHECKBOX_GROUP',
  'USER_REFERENCE',
  'TEAM_REFERENCE',
  'RELATION',
  'MULTI_LOOKUP',
  'FILE_UPLOAD',
]);

export const isMaskableFieldType = (type: FieldType): boolean =>
  MASKABLE_FIELD_TYPES.has(type);
