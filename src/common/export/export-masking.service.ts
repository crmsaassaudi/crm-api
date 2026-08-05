import { Injectable } from '@nestjs/common';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { LAYOUT_SETTINGS_KEY } from '../../object-manager/layout/layout-settings.service';
import {
  MaskingStrategy,
  ResolvedFieldPolicy,
  applyMask,
  resolveFieldPolicy,
  selectApplicableLayouts,
} from '../../object-manager/layout/field-policy';
import {
  ConfigurableObject,
  isConfigurableObject,
} from '../../object-manager/object-registry';
import { ObjectRegistryService } from '../../object-manager/object-registry.service';

/**
 * The field policy applied while generating an export file.
 *
 * A BullMQ worker has no HTTP context, so it cannot resolve the caller's groups or
 * run `FieldPolicyInterceptor`. What it can do — and now does — is use the same
 * pure resolution against a snapshot taken at enqueue time. This used to be a
 * third independent re-implementation of the merge rules, and it disagreed with
 * both others: it read a single `groupId` (from the CLS key nothing ever wrote, so
 * always `undefined` → `default`), it matched on the browser's column keys rather
 * than payload keys, and it knew nothing about `hidden`.
 *
 * Consequences, all silent: exports ignored per-group masking entirely, masking
 * configured on `owner`/`amount`/`type` never matched a column, and a field an
 * admin had hidden was exported in full. An export is the easiest way to get data
 * out of the product, so it is the last place a field policy should be weaker than
 * the API.
 */
@Injectable()
export class ExportMaskingService {
  constructor(
    private readonly settingsService: CrmSettingsService,
    private readonly registry: ObjectRegistryService,
  ) {}

  /**
   * Build a masker for one export job.
   *
   * @param groupIds the requester's group ids, snapshotted at enqueue time.
   *   `[]` selects the tenant's default layout — the conservative direction, and
   *   the same fallback the request path takes.
   */
  async buildMasker(
    tenantId: string,
    groupIds: readonly string[] | undefined,
    resource: string,
  ): Promise<ExportMasker> {
    if (!isConfigurableObject(resource)) {
      // Nothing to enforce for a resource with no field registry (omni exports,
      // audit logs). An empty masker is honest: there is no policy, rather than a
      // policy we failed to load.
      return new ExportMasker(EMPTY_POLICY);
    }

    const settings = await this.settingsService.getSetting(
      LAYOUT_SETTINGS_KEY,
      tenantId,
    );

    const layouts = selectApplicableLayouts(
      settings?.groupLayouts,
      groupIds ?? [],
    );
    if (layouts.length === 0) return new ExportMasker(EMPTY_POLICY);

    const object: ConfigurableObject = resource;
    return new ExportMasker(
      resolveFieldPolicy({
        object,
        layouts,
        resolveField: (key) => this.registry.resolveFieldKey(object, key),
        payloadKeysOf: (field) => this.registry.payloadKeysOf(field),
      }),
    );
  }
}

const EMPTY_POLICY: ResolvedFieldPolicy = {
  hidden: new Set(),
  readOnly: new Set(),
  masking: new Map(),
  required: new Set(),
};

export class ExportMasker {
  constructor(private readonly policy: ResolvedFieldPolicy) {}

  /** True when at least one field needs rewriting, so the engine can skip work. */
  get active(): boolean {
    return this.policy.masking.size > 0 || this.policy.hidden.size > 0;
  }

  /** True when the field must not appear in the file at all. */
  isHidden(fieldKey: string): boolean {
    return this.policy.hidden.has(fieldKey);
  }

  /** Mask one value. Arrays are masked per element. */
  maskValue(fieldKey: string, value: unknown): unknown {
    if (this.policy.hidden.has(fieldKey)) return null;

    const strategy = this.policy.masking.get(fieldKey);
    if (!strategy) return value;

    // A numeric field is blanked rather than stringified: writing '********' into
    // a currency column produces a file the recipient's spreadsheet cannot parse,
    // and leaving it untouched is how a masked deal value used to export in full.
    if (typeof value === 'number') return null;
    if (typeof value === 'string') return applyMask(value, strategy);
    if (Array.isArray(value)) {
      return value.map((entry) =>
        typeof entry === 'string' ? applyMask(entry, strategy) : entry,
      );
    }
    return value;
  }

  /** Exposed for the column planner, which drops hidden columns before writing. */
  get maskedKeys(): ReadonlyMap<string, MaskingStrategy> {
    return this.policy.masking;
  }
}
