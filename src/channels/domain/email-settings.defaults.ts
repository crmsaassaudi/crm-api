/** Default email channel settings. */

export interface EmailSettings {
  trackingEnabled: boolean;

  trackingDefaultPerEmail: boolean;

  lazyReplyBreakDays: number;

  dailyQuotaOverride: number;

  bulkRecipientLimit: number;

  signatureAutoAppend: boolean;

  historicalSyncMode: 'contact_enriched' | 'auto_discover';

  domainBlacklistExtra: string[];

  immutableRecords: boolean;

  gdprAutoRedactDays: number;

  syncReadState: boolean;

  /**
   * Mailbox ownership model.
   * personal: one agent owns the provider mailbox.
   * shared: support@/sales@ style mailbox routed through Omni.
   */
  mailboxType: 'personal' | 'shared';

  /**
   * Provider label sync policy for enterprise mailboxes.
   */
  labelSyncMode: 'none' | 'pull_only' | 'two_way';

  /**
   * Standard mailbox folders/labels CRM should sync.
   */
  syncTargetFolders: Array<'INBOX' | 'SENT' | 'DRAFTS' | 'TRASH' | 'SPAM'>;

  /**
   * Provider read-state writeback behavior.
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
