import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { CustomFieldsService } from './custom-fields.service';
import { CustomField } from './domain/custom-field';

/**
 * Validates and coerces per-record `customFields` values against the tenant's
 * `custom_fields` registry.
 *
 * The registry was already well built — typed, ordered, with `validation` and
 * `governance` sub-documents and a unique `(tenantId, internalKey, module)`
 * index — and nothing consumed it at write time. `customFields` on Contact,
 * Account and Deal is a `Mixed` column, so any key of any shape was accepted.
 * Three consequences, all of them silent:
 *
 *   1. Type drift. The same key held `"5"`, `5` and `null` across records, so
 *      report `$group`s split into several buckets and automation comparisons
 *      (`condition-evaluator` reads `customFields.<key>` by dot-path) matched
 *      inconsistently depending on which client wrote the row.
 *   2. Undeclared keys. A typo in an integration payload created a permanent new
 *      key that no admin could see or clean up.
 *   3. `isRequired` in the registry meant nothing.
 *
 * Coercing here — rather than only rejecting — matters because the same values
 * arrive from CSV import as strings. `"true"`, `"5"` and `"2026-01-01"` are the
 * correct values in the wrong type; failing them would make imports unusable,
 * while storing them as-is is what caused the drift.
 *
 * Unknown keys are dropped rather than rejected, so an integration that sends an
 * extra column does not start failing every write — but the drop is logged, and
 * `strict` mode is available for the API path where a typo should surface.
 */
@Injectable()
export class CustomFieldValueValidator {
  private readonly logger = new Logger(CustomFieldValueValidator.name);

  constructor(private readonly customFields: CustomFieldsService) {}

  /**
   * Validate + coerce `values` for `module`.
   *
   * @param module  registry module name ('Contact', 'Deal', …)
   * @param values  the submitted `customFields` object
   * @param options `partial` skips required-field checks (PATCH); `strict`
   *                rejects undeclared keys instead of dropping them.
   * @returns the coerced object, safe to persist.
   */
  async validate(
    module: string,
    values: Record<string, unknown> | undefined,
    options: { partial?: boolean; strict?: boolean } = {},
  ): Promise<Record<string, unknown> | undefined> {
    if (values === undefined) return undefined;
    if (
      values === null ||
      typeof values !== 'object' ||
      Array.isArray(values)
    ) {
      throw new BadRequestException('customFields must be an object');
    }

    const definitions = await this.loadDefinitions(module);
    // No registry for this module → nothing to validate against. Pass the values
    // through rather than rejecting: a tenant that has not defined any custom
    // fields must still be able to save a record.
    if (definitions.size === 0) return values;

    const result: Record<string, unknown> = {};
    const errors: Record<string, string> = {};

    for (const [key, raw] of Object.entries(values)) {
      const definition = definitions.get(key);
      if (!definition) {
        if (options.strict) {
          errors[key] = `Unknown custom field "${key}" for module ${module}`;
          continue;
        }
        this.logger.warn(
          `Dropping undeclared custom field "${key}" on ${module} — ` +
            'not present in the tenant custom_fields registry',
        );
        continue;
      }

      if (raw === null || raw === '') {
        // Explicit clear. Keep it: a user must be able to empty a field.
        result[key] = null;
        continue;
      }

      try {
        result[key] = this.coerce(definition, raw);
      } catch (err) {
        errors[key] = err instanceof Error ? err.message : String(err);
      }
    }

    if (!options.partial) {
      for (const [key, definition] of definitions) {
        if (!definition.validation?.isRequired) continue;
        if (result[key] === undefined || result[key] === null) {
          errors[key] = `${definition.displayLabel} is required`;
        }
      }
    }

    if (Object.keys(errors).length > 0) {
      throw new BadRequestException({ customFields: errors });
    }

    return result;
  }

  private async loadDefinitions(
    module: string,
  ): Promise<Map<string, CustomField>> {
    try {
      const fields = await this.customFields.getByModule(module);
      return new Map(fields.map((f) => [f.internalKey, f]));
    } catch (err) {
      // A registry read failure must not block a write. Failing open here is
      // the right direction: custom-field validation is a data-quality control,
      // not a security control, and a settings-service blip should not take
      // record creation down.
      this.logger.error(
        `Could not load custom_fields for ${module}; skipping validation: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return new Map();
    }
  }

  /** Coerce one value to its declared type, or throw with a usable message. */
  private coerce(definition: CustomField, raw: unknown): unknown {
    const { fieldType, validation, options } = definition;

    switch (fieldType) {
      case 'TEXT':
      case 'TEXTAREA':
      case 'EMAIL':
      case 'PHONE':
      case 'URL':
      case 'ENCRYPTED':
        return this.coerceString(definition, raw);

      case 'NUMBER':
      case 'DECIMAL':
      case 'CURRENCY':
      case 'PERCENTAGE':
      case 'SCORE': {
        const num = Number(raw);
        if (!Number.isFinite(num)) {
          throw new Error(`${definition.displayLabel} must be a number`);
        }
        if (fieldType === 'NUMBER' && !Number.isInteger(num)) {
          throw new Error(`${definition.displayLabel} must be a whole number`);
        }
        if (fieldType === 'PERCENTAGE' && (num < 0 || num > 100)) {
          throw new Error(
            `${definition.displayLabel} must be between 0 and 100`,
          );
        }
        return num;
      }

      case 'BOOLEAN': {
        if (typeof raw === 'boolean') return raw;
        const text = String(raw).trim().toLowerCase();
        if (['true', '1', 'yes', 'y'].includes(text)) return true;
        if (['false', '0', 'no', 'n'].includes(text)) return false;
        throw new Error(`${definition.displayLabel} must be true or false`);
      }

      case 'DATE':
      case 'DATETIME': {
        const date = new Date(String(raw));
        if (Number.isNaN(date.getTime())) {
          throw new Error(`${definition.displayLabel} must be a valid date`);
        }
        return date;
      }

      case 'TIME':
        // Stored as a string: a time without a date is not a Date.
        if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(String(raw).trim())) {
          throw new Error(`${definition.displayLabel} must be HH:MM`);
        }
        return String(raw).trim();

      case 'SINGLE_SELECT':
      case 'RADIO': {
        const value = String(raw);
        this.assertAllowedOption(definition, value, options);
        return value;
      }

      case 'MULTI_SELECT':
      case 'CHECKBOX_GROUP': {
        const list = Array.isArray(raw)
          ? raw.map(String)
          : String(raw)
              .split(/[,;]/)
              .map((v) => v.trim())
              .filter(Boolean);
        for (const value of list) {
          this.assertAllowedOption(definition, value, options);
        }
        return Array.from(new Set(list));
      }

      case 'USER_REFERENCE':
      case 'TEAM_REFERENCE':
      case 'RELATION':
        return String(raw);

      case 'MULTI_LOOKUP':
        return (Array.isArray(raw) ? raw : [raw]).map(String);

      case 'JSON':
        if (typeof raw === 'object') return raw;
        try {
          return JSON.parse(String(raw));
        } catch {
          throw new Error(`${definition.displayLabel} must be valid JSON`);
        }

      case 'FORMULA':
        // Derived server-side; a client-supplied value is meaningless and
        // accepting it would let a caller fake a computed number.
        throw new Error(
          `${definition.displayLabel} is a formula field and cannot be set directly`,
        );

      case 'FILE_UPLOAD':
        return String(raw);

      default:
        // An unrecognised type is a registry the code has not caught up with.
        // Store the value untouched rather than blocking the write.
        this.logger.warn(
          `Unknown fieldType "${fieldType}" for ${definition.internalKey}; stored unvalidated`,
        );
        void validation;
        return raw;
    }
  }

  private coerceString(definition: CustomField, raw: unknown): string {
    const value = String(raw);
    const rules = definition.validation ?? {};
    if (rules.minLength !== undefined && value.length < rules.minLength) {
      throw new Error(
        `${definition.displayLabel} must be at least ${rules.minLength} characters`,
      );
    }
    if (rules.maxLength !== undefined && value.length > rules.maxLength) {
      throw new Error(
        `${definition.displayLabel} must be at most ${rules.maxLength} characters`,
      );
    }
    if (definition.fieldType === 'EMAIL' && !value.includes('@')) {
      throw new Error(`${definition.displayLabel} must be an email address`);
    }
    return value;
  }

  private assertAllowedOption(
    definition: CustomField,
    value: string,
    options?: { label: string; value: string }[],
  ): void {
    if (!options || options.length === 0) return;
    if (options.some((o) => o.value === value)) return;
    throw new Error(
      `${definition.displayLabel} must be one of: ${options
        .map((o) => o.value)
        .join(', ')}`,
    );
  }
}
