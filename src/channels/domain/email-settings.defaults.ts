/**
 * Default email channel settings — extracted to a standalone file
 * to prevent circular dependency between CrmSettingsModule and ChannelsModule.
 *
 * This file MUST NOT import any @Injectable() services.
 */

export interface EmailSettings {
  /** Enable email open tracking pixel injection. GDPR: must be opt-in. */
  trackingEnabled: boolean;

  /** Default state for "Track this email" checkbox in compose panel. */
  trackingDefaultPerEmail: boolean;

  /** Number of days before a stale thread triggers soft-link break. */
  lazyReplyBreakDays: number;

  /** Override daily sending quota (0 = use provider default). */
  dailyQuotaOverride: number;

  /** Max recipients per single email dispatch. */
  bulkRecipientLimit: number;

  /** Auto-append user signature to outbound emails. */
  signatureAutoAppend: boolean;

  /** Preferred historical sync mode. */
  historicalSyncMode: 'contact_enriched' | 'auto_discover';

  /** Tenant-specific domain blacklist additions for historical sync. */
  domainBlacklistExtra: string[];

  /** Immutable Records: never propagate provider-side deletes. */
  immutableRecords: boolean;

  /** GDPR: auto-redact email content after N days (0 = disabled). */
  gdprAutoRedactDays: number;
}

export const DEFAULT_EMAIL_SETTINGS: EmailSettings = {
  trackingEnabled: false, // Opt-in model (GDPR safe)
  trackingDefaultPerEmail: false, // Don't track by default
  lazyReplyBreakDays: 90, // 90 days before thread break
  dailyQuotaOverride: 0, // Use provider default
  bulkRecipientLimit: 500, // Match backend guard
  signatureAutoAppend: true, // Auto-append signatures
  historicalSyncMode: 'auto_discover',
  domainBlacklistExtra: [], // No extra domains
  immutableRecords: true, // Don't delete emails
  gdprAutoRedactDays: 0, // Disabled by default
};
