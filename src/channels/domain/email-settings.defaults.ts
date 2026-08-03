/**
 * The email channel settings shape and every default, in one place.
 *
 * A standalone file so CrmSettingsModule and ChannelsModule can both read it
 * without importing each other. It MUST NOT import any `@Injectable()` service —
 * doing so recreates the circular dependency this extraction exists to break.
 */

export interface EmailSettings {
  /** Open-tracking pixel injection. Opt-in: GDPR requires consent. */
  trackingEnabled: boolean;

  /** Default state of the "Track this email" checkbox in the compose panel. */
  trackingDefaultPerEmail: boolean;

  /** Days before a stale thread triggers a soft link break. */
  lazyReplyBreakDays: number;

  /** Daily send quota override. 0 = use the provider's own limit. */
  dailyQuotaOverride: number;

  /** Max recipients per single dispatch. */
  bulkRecipientLimit: number;

  /** Append the user's signature to outbound mail. */
  signatureAutoAppend: boolean;

  /** Preferred historical sync mode. */
  historicalSyncMode: 'contact_enriched' | 'auto_discover';

  /** Tenant-specific additions to the historical-sync domain blacklist. */
  domainBlacklistExtra: string[];

  /** Never propagate a provider-side delete into the CRM. */
  immutableRecords: boolean;

  /** Auto-redact email content after N days. 0 = disabled. */
  gdprAutoRedactDays: number;

  /** Opt-in: write read status back to the provider (Gmail/Outlook). */
  syncReadState: boolean;

  /**
   * Mailbox ownership model.
   * personal: one agent owns the provider mailbox.
   * shared: support@/sales@ style mailbox routed through Omni.
   */
  mailboxType: 'personal' | 'shared';

  /**
   * Provider label sync policy.
   *
   * `pull_only` is the safe default for enterprise shared mailboxes: it keeps
   * the provider's context without creating CRM tag churn or write bursts.
   * Providers map these differently — Outlook folders vs Gmail system labels.
   */
  labelSyncMode: 'none' | 'pull_only' | 'two_way';

  /** Standard mailbox folders/labels the CRM should sync. */
  syncTargetFolders: Array<'INBOX' | 'SENT' | 'DRAFTS' | 'TRASH' | 'SPAM'>;

  /**
   * Provider read-state writeback behaviour. `syncOnlyOnAction` avoids marking a
   * shared provider mailbox as read merely because an agent opened it in the CRM.
   */
  readStateStrategy: {
    syncToProvider: boolean;
    syncOnlyOnAction: boolean;
  };

  collisionDetectionEnabled: boolean;

  initialSyncDays: number;

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
