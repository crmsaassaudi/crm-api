import {
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { LayoutSettingsService } from '../layout/layout-settings.service';
import {
  ObjectPicklists,
  PicklistProvider,
} from '../picklists/picklist.provider';
import { ConfigurableObject } from '../object-registry';
import { ObjectRegistryService } from '../object-registry.service';
import {
  StoredValidationRules,
  ValidationRule,
  evaluateRule,
} from './validation-rule';

export const VALIDATION_RULES_KEY = 'validation_rules';

export type WriteMode = 'create' | 'update';

/**
 * Applies the tenant's declarative write rules — required fields and validation
 * rules — to a record payload.
 *
 * Why one service for both
 *
 * They are the same kind of thing (a tenant-authored constraint on a write, read
 * from settings, reported as a 422 field map) and they were broken in the same two
 * ways: only two of the five modules checked required fields at all, and nothing
 * anywhere checked validation rules. Two half-implementations of one idea is what
 * let "Ticket type is required" mean a permanent 422 while "email must match this
 * pattern" meant nothing outside the browser.
 *
 * The bug this replaces
 *
 * `TicketsService.validateRequiredFields` read `layout_settings.groupLayouts
 * ['default'].Ticket` and asserted `data[field.key]`. `field.key` came from the
 * browser's field catalog, so it was `type` where the payload says `typeId`.
 * Marking Type required made `data['type']` permanently absent and every ticket
 * create returned 422 with no way to clear it. Two things prevent that now: keys
 * are resolved through the registry (so `type` finds `typeId`), and read-only
 * fields cannot be required at all (so the unsatisfiable case cannot be
 * configured).
 */
@Injectable()
export class RecordWriteValidator {
  private readonly logger = new Logger(RecordWriteValidator.name);

  constructor(
    private readonly layouts: LayoutSettingsService,
    private readonly settings: CrmSettingsService,
    private readonly registry: ObjectRegistryService,
    private readonly picklists: PicklistProvider,
  ) {}

  /**
   * Validate `data` for `object`, throwing a 422 with a per-field error map.
   *
   * @param scope request-scoped memoisation key; see `LayoutSettingsService.policyFor`.
   */
  async assertValid(
    object: ConfigurableObject,
    data: Record<string, unknown>,
    mode: WriteMode,
    scope?: object,
  ): Promise<void> {
    const [policy, rules, picklists] = await Promise.all([
      this.layouts.policyFor(object, scope),
      this.rulesFor(object),
      this.picklists.forObject(object),
    ]);

    const errors: Record<string, string> = {};

    this.collectPicklistErrors(object, data, picklists, errors);

    for (const key of policy.required) {
      // On update, a field absent from the payload is untouched, not cleared —
      // requiring it would make every PATCH send the whole record.
      if (mode === 'update' && !(key in data)) continue;
      if (isEmpty(data[key])) {
        errors[key] ??= `${key} is required`;
      }
    }

    for (const rule of rules) {
      const field = this.registry.resolveFieldKey(object, rule.field);
      // A rule naming a field the object does not have is inert — that is what a
      // rule looks like after its field is retired. Logged once per evaluation
      // rather than silently skipped, because "the rule does nothing" and "the
      // rule passes" are indistinguishable from the outside.
      if (!field) {
        this.logger.warn(
          `Validation rule "${rule.name}" targets unknown ${object} field "${rule.field}"; skipped`,
        );
        continue;
      }
      if (mode === 'update' && !(field.key in data)) continue;
      if (field.readOnly) continue;

      const message = evaluateRule(rule, data[field.key]);
      if (message) errors[field.key] ??= message;
    }

    if (Object.keys(errors).length > 0) {
      throw new UnprocessableEntityException({ status: 422, errors });
    }
  }

  /**
   * Refuse a picklist value the tenant has not configured.
   *
   * Ticket and Task already check `statusId` and friends against their collections.
   * Account and Deal checked nothing at all, which is the quiet half of the
   * split-brain: a `stageId` from the old settings blob was accepted and stored,
   * and then no screen reading `deal_stages` could name it — a deal with a stage
   * that renders blank and drops out of the board.
   *
   * The option set is already loaded for this write, so the check is a `Set` lookup
   * rather than a query. An empty option set skips validation: a tenant that has
   * configured no statuses must still be able to save a record, and that is the
   * same rule `CustomFieldValueValidator.assertAllowedOption` already follows.
   */
  private collectPicklistErrors(
    object: ConfigurableObject,
    data: Record<string, unknown>,
    picklists: ObjectPicklists,
    errors: Record<string, string>,
  ): void {
    for (const [fieldKey, options] of Object.entries(picklists)) {
      if (options.length === 0) continue;
      if (!(fieldKey in data)) continue;

      const raw = data[fieldKey];
      // Clearing an optional picklist is not an invalid value.
      if (raw === undefined || raw === null || raw === '') continue;

      const allowed = new Set(options.map((option) => option.value));
      const submitted = Array.isArray(raw) ? raw : [raw];
      const unknown = submitted
        .map(String)
        .filter((value) => value && !allowed.has(value));

      if (unknown.length > 0) {
        const field = this.registry.field(object, fieldKey);
        errors[fieldKey] ??=
          `${field?.labelToken ?? fieldKey} does not reference a configured value in this tenant`;
      }
    }
  }

  /** Active rules for one object, keyed by whatever name the document used. */
  private async rulesFor(
    object: ConfigurableObject,
  ): Promise<ValidationRule[]> {
    try {
      const stored: StoredValidationRules | undefined =
        await this.settings.getSetting(VALIDATION_RULES_KEY);
      const forObject = stored?.rules?.[object];
      return Array.isArray(forObject)
        ? forObject.filter((rule) => rule?.isActive !== false)
        : [];
    } catch (error) {
      // A settings read failure must not block writes. Validation rules are a
      // data-quality control, not a security control, so the fail-open direction
      // is the right one — the same call this codebase already makes for
      // custom-field validation, and for the same reason.
      this.logger.error(
        `Could not load validation rules for ${object}; skipping them: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
}

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0);
