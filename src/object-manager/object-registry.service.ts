import { BadRequestException, Injectable } from '@nestjs/common';
import {
  CONFIGURABLE_OBJECTS,
  ConfigurableObject,
  STANDARD_FIELDS,
  StandardFieldDescriptor,
  isConfigurableObject,
  isFieldMaskable,
  isFieldRequirable,
} from './object-registry';

/**
 * Lookups over the standard field registry.
 *
 * Every index is built once at construction, not per request: the registry is a
 * frozen module-level constant, so a `Map` per object is the whole cost of every
 * lookup this service will ever serve. The consumers — `FieldPolicyInterceptor`
 * and each module's `validateRequiredFields` — run on the hot path of every
 * response, and the previous implementation walked an array on each one.
 */
@Injectable()
export class ObjectRegistryService {
  private readonly byFieldKey: Record<
    ConfigurableObject,
    ReadonlyMap<string, StandardFieldDescriptor>
  >;

  private readonly byColumnKey: Record<
    ConfigurableObject,
    ReadonlyMap<string, StandardFieldDescriptor>
  >;

  /** Column keys plus legacy aliases — every name a stored document might use. */
  private readonly byAnyKey: Record<
    ConfigurableObject,
    ReadonlyMap<string, StandardFieldDescriptor>
  >;

  constructor() {
    const byFieldKey = {} as Record<
      ConfigurableObject,
      ReadonlyMap<string, StandardFieldDescriptor>
    >;
    const byColumnKey = {} as Record<
      ConfigurableObject,
      ReadonlyMap<string, StandardFieldDescriptor>
    >;
    const byAnyKey = {} as Record<
      ConfigurableObject,
      ReadonlyMap<string, StandardFieldDescriptor>
    >;

    for (const object of CONFIGURABLE_OBJECTS) {
      const fields = STANDARD_FIELDS[object];
      byFieldKey[object] = new Map(fields.map((field) => [field.key, field]));
      byColumnKey[object] = new Map(
        fields.map((field) => [columnKeyOf(field), field]),
      );

      // Precedence matters: a payload key always wins over an alias, so a field
      // legitimately named `name` is never shadowed by another field's legacy
      // alias for it.
      const any = new Map<string, StandardFieldDescriptor>();
      for (const field of fields) {
        for (const alias of field.legacyAliases ?? []) any.set(alias, field);
      }
      for (const field of fields) any.set(columnKeyOf(field), field);
      for (const field of fields) any.set(field.key, field);
      byAnyKey[object] = any;
    }

    this.byFieldKey = byFieldKey;
    this.byColumnKey = byColumnKey;
    this.byAnyKey = byAnyKey;
  }

  /** Every standard field of an object, in declaration order. */
  fields(object: ConfigurableObject): readonly StandardFieldDescriptor[] {
    return STANDARD_FIELDS[object];
  }

  field(
    object: ConfigurableObject,
    fieldKey: string,
  ): StandardFieldDescriptor | undefined {
    return this.byFieldKey[object].get(fieldKey);
  }

  /**
   * Resolve a *column* key (`owner`, `status`, `fullName`) to its field.
   *
   * This is the translation that did not exist, and whose absence let a list view
   * and a masking policy disagree about what "owner" means.
   */
  fieldByColumn(
    object: ConfigurableObject,
    columnKey: string,
  ): StandardFieldDescriptor | undefined {
    return this.byColumnKey[object].get(columnKey);
  }

  /**
   * Translate a stored layout/validation key written before the two namespaces
   * were separated.
   *
   * Old documents anchored on column keys (`owner`, `amount`, `type`). Accepting
   * both on read means the migration is not a hard cutover and a settings document
   * that predates it keeps working.
   */
  resolveFieldKey(
    object: ConfigurableObject,
    key: string,
  ): StandardFieldDescriptor | undefined {
    return this.byAnyKey[object].get(key);
  }

  /**
   * Every payload property a policy on `field` must cover — the field itself plus
   * any server-maintained duplicate of it.
   */
  payloadKeysOf(field: StandardFieldDescriptor): string[] {
    return field.mirroredKeys?.length
      ? [field.key, ...field.mirroredKeys]
      : [field.key];
  }

  /** Fields a masking policy can act on. */
  maskableFields(object: ConfigurableObject): StandardFieldDescriptor[] {
    return STANDARD_FIELDS[object].filter(isFieldMaskable);
  }

  /** Fields that may carry `isRequired`. */
  requirableFieldKeys(object: ConfigurableObject): ReadonlySet<string> {
    return new Set(
      STANDARD_FIELDS[object].filter(isFieldRequirable).map((f) => f.key),
    );
  }

  /** Fields the server owns — a client value for these is discarded. */
  readOnlyFieldKeys(object: ConfigurableObject): ReadonlySet<string> {
    return new Set(
      STANDARD_FIELDS[object]
        .filter((field) => field.readOnly)
        .map((field) => field.key),
    );
  }

  /** Narrow an untrusted route/query param, with a message that lists the options. */
  assertObject(value: unknown): ConfigurableObject {
    if (!isConfigurableObject(value)) {
      throw new BadRequestException(
        `Unknown object "${String(value)}". Expected one of: ${CONFIGURABLE_OBJECTS.join(', ')}`,
      );
    }
    return value;
  }
}

export const columnKeyOf = (field: StandardFieldDescriptor): string =>
  field.column ?? field.key;
