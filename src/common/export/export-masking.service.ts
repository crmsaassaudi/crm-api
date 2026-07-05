import { Injectable } from '@nestjs/common';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';

/**
 * Per-job masking applied while generating an export file.
 *
 * The HTTP `DataMaskingInterceptor` cannot run in a BullMQ worker (no HTTP
 * context, and `userGroupId` is not in the worker's CLS store), so this service
 * re-implements the SAME masking rules in a context-free way:
 *   layout_settings.groupLayouts[groupId][resource] → [{ key, masking }]
 *
 * Mask types mirror the interceptor: 'mask_all' → '********',
 * 'last_4' → '****' + last 4 chars.
 */
@Injectable()
export class ExportMaskingService {
  constructor(private readonly settingsService: CrmSettingsService) {}

  /**
   * Build a masker for one export job. Loads the tenant's layout once, resolves
   * the masked fields for `resource`, and returns a cheap per-value masker.
   */
  async buildMasker(
    tenantId: string,
    groupId: string | undefined,
    resource: string,
  ): Promise<ExportMasker> {
    const effectiveGroup = groupId || 'default';
    const layoutSettings = await this.settingsService.getSetting(
      'layout_settings',
      tenantId,
    );
    const layoutConfig =
      layoutSettings?.groupLayouts?.[effectiveGroup] ??
      layoutSettings?.groupLayouts?.['default'];

    // Mirror the interceptor: Contact/Lead share the 'Contact' layout.
    const resolvedResource =
      resource === 'Contact' || resource === 'Lead' ? 'Contact' : resource;

    const maskedFields = new Map<string, string>();
    const configs = layoutConfig?.[resolvedResource];
    if (Array.isArray(configs)) {
      for (const config of configs) {
        if (config?.masking && config.masking !== 'none') {
          maskedFields.set(config.key, config.masking);
        }
      }
    }

    return new ExportMasker(maskedFields);
  }
}

export class ExportMasker {
  constructor(private readonly maskedFields: Map<string, string>) {}

  /** True if at least one field needs masking (lets the engine skip work). */
  get active(): boolean {
    return this.maskedFields.size > 0;
  }

  /** Mask a single value for a given field key. Arrays are masked per-element. */
  maskValue(fieldKey: string, value: unknown): unknown {
    const maskingType = this.maskedFields.get(fieldKey);
    if (!maskingType) return value;

    if (typeof value === 'string') {
      return this.applyMask(value, maskingType);
    }
    if (Array.isArray(value)) {
      return value.map((v) =>
        typeof v === 'string' ? this.applyMask(v, maskingType) : v,
      );
    }
    return value;
  }

  private applyMask(value: string, maskingType: string): string {
    if (!value || value.includes('***')) return value;
    if (maskingType === 'mask_all') {
      return '********';
    }
    if (maskingType === 'last_4') {
      return value.length <= 4 ? '********' : '****' + value.slice(-4);
    }
    return value;
  }
}
