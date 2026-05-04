import { Injectable, Logger } from '@nestjs/common';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { DEFAULT_EMAIL_SETTINGS } from '../domain/email-settings.defaults';
import type { EmailSettings } from '../domain/email-settings.defaults';

// Re-export for backward compatibility with existing imports
export { DEFAULT_EMAIL_SETTINGS };
export type { EmailSettings };

/**
 * Tenant-level Email Channel Settings — Single source of truth.
 *
 * All email-related behaviour flags are stored as a single `email_settings`
 * key in the CRM Settings system. This service wraps the CrmSettingsService
 * to provide typed access with proper defaults.
 *
 * These settings are lazy-seeded on first access (existing tenants) or
 * explicitly seeded on tenant creation via TenantSettingsSeedingService.
 *
 * ┌─────────────────── email_settings schema ───────────────────┐
 * │  trackingEnabled:           boolean  (opt-in, default OFF)  │
 * │  trackingDefaultPerEmail:   boolean  (per-compose checkbox) │
 * │  lazyReplyBreakDays:        number   (configurable SLA)     │
 * │  dailyQuotaOverride:        number   (0 = use provider def) │
 * │  bulkRecipientLimit:        number   (max recipients/email) │
 * │  signatureAutoAppend:       boolean  (auto-append sigs)     │
 * │  historicalSyncMode:        string   (last-used sync mode)  │
 * │  domainBlacklistExtra:      string[] (tenant-specific)      │
 * │  immutableRecords:          boolean  (never delete emails)  │
 * │  gdprAutoRedactDays:        number   (0 = disabled)         │
 * └─────────────────────────────────────────────────────────────┘
 */

const SETTINGS_KEY = 'email_settings';

@Injectable()
export class EmailChannelSettingsService {
  private readonly logger = new Logger(EmailChannelSettingsService.name);

  constructor(private readonly crmSettings: CrmSettingsService) {}

  /**
   * Get the full email settings object for the current tenant.
   * Merges stored values with defaults to handle schema evolution.
   */
  async getSettings(tenantId?: string): Promise<EmailSettings> {
    const stored = await this.crmSettings.getSetting(SETTINGS_KEY, tenantId);
    if (!stored) return { ...DEFAULT_EMAIL_SETTINGS };

    // Merge with defaults to handle new fields added after tenant was seeded
    return {
      ...DEFAULT_EMAIL_SETTINGS,
      ...(stored as Partial<EmailSettings>),
    };
  }

  /**
   * Update email settings (partial merge).
   * Validates critical fields before persisting.
   */
  async updateSettings(
    updates: Partial<EmailSettings>,
    tenantId?: string,
  ): Promise<EmailSettings> {
    const current = await this.getSettings(tenantId);

    // Validate
    if (updates.lazyReplyBreakDays !== undefined) {
      if (updates.lazyReplyBreakDays < 1 || updates.lazyReplyBreakDays > 365) {
        throw new Error('lazyReplyBreakDays must be between 1 and 365');
      }
    }
    if (updates.dailyQuotaOverride !== undefined) {
      if (
        updates.dailyQuotaOverride < 0 ||
        updates.dailyQuotaOverride > 50000
      ) {
        throw new Error('dailyQuotaOverride must be between 0 and 50000');
      }
    }
    if (updates.bulkRecipientLimit !== undefined) {
      if (updates.bulkRecipientLimit < 1 || updates.bulkRecipientLimit > 2000) {
        throw new Error('bulkRecipientLimit must be between 1 and 2000');
      }
    }
    if (updates.gdprAutoRedactDays !== undefined) {
      if (updates.gdprAutoRedactDays < 0 || updates.gdprAutoRedactDays > 3650) {
        throw new Error(
          'gdprAutoRedactDays must be between 0 and 3650 (10 years)',
        );
      }
    }

    const merged: EmailSettings = { ...current, ...updates };
    await this.crmSettings.updateSetting(SETTINGS_KEY, merged, tenantId);

    this.logger.log(
      `[EmailSettings] Updated for tenant ${tenantId ?? 'current'}`,
    );
    return merged;
  }

  /**
   * Helper: check if tracking is enabled for the current tenant.
   */
  async isTrackingEnabled(tenantId?: string): Promise<boolean> {
    const settings = await this.getSettings(tenantId);
    return settings.trackingEnabled;
  }

  /**
   * Helper: get lazy reply break days for thread correlation.
   */
  async getLazyReplyBreakDays(tenantId?: string): Promise<number> {
    const settings = await this.getSettings(tenantId);
    return settings.lazyReplyBreakDays;
  }

  /**
   * Helper: get the effective daily quota (override or provider default).
   */
  async getEffectiveDailyQuota(
    providerDefault: number,
    tenantId?: string,
  ): Promise<number> {
    const settings = await this.getSettings(tenantId);
    return settings.dailyQuotaOverride > 0
      ? settings.dailyQuotaOverride
      : providerDefault;
  }
}
