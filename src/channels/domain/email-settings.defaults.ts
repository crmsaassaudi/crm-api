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

  /** Opt-in: sync read status back to email provider (Gmail/Outlook). */
  syncReadState: boolean;

  /**
   * Mailbox ownership model.
   * personal: one agent owns the provider mailbox.
   * shared: support@/sales@ style mailbox routed through Omni.
   */
  mailboxType: 'personal' | 'shared';

  /**
   * Provider label sync policy.
   * pull_only is the safe default for enterprise shared mailboxes because it
   * preserves provider context without creating CRM tag churn or write bursts.
   */
  labelSyncMode: 'none' | 'pull_only' | 'two_way';

  /**
   * Standard mailbox folders/labels CRM should sync.
   * Providers map these differently: Outlook folders, Gmail system labels.
   */
  syncTargetFolders: Array<'INBOX' | 'SENT' | 'DRAFTS' | 'TRASH' | 'SPAM'>;

  /**
   * Provider read-state writeback behavior.
   * syncOnlyOnAction avoids marking shared provider mailboxes as read on view.
   */
  readStateStrategy: {
    syncToProvider: boolean;
    syncOnlyOnAction: boolean;
  };

  /** Enable collaborative locking/collision detection for shared mailboxes. */
  collisionDetectionEnabled: boolean;

  /** Number of days to look back for emails during the first synchronization. */
  initialSyncDays: number;

  /** Whether to filter out and drop auto-responders/system-generated emails. */
  blockAutoResponders: boolean;
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
  syncReadState: false, // Opt-in model — disabled by default
  mailboxType: 'shared',
  labelSyncMode: 'pull_only',
  syncTargetFolders: ['INBOX', 'SENT'],
  readStateStrategy: {
    syncToProvider: false,
    syncOnlyOnAction: true,
  },
  collisionDetectionEnabled: true,
  initialSyncDays: 30, // Default window for first-run sync
  blockAutoResponders: false, // Sync ALL by default as requested
};
