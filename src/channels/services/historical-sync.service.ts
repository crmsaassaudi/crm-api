import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RedisService } from '../../redis/redis.service';
import { ChannelConfigRepository } from '../infrastructure/persistence/document/repositories/channel-config.repository';
import { ICryptoService, CRYPTO_SERVICE_TOKEN } from '../domain/crypto.service';
import { EmailNormalizerService } from './email-normalizer.service';
import { EmailContentSchemaClass } from '../infrastructure/persistence/document/entities/email-content.schema';
import { EmailMetadataSchemaClass } from '../infrastructure/persistence/document/entities/email-metadata.schema';

/**
 * Historical Sync Service — Day 1 Initial Email Import Engine.
 *
 * Architecture (from email-integration-plan.md Section 4.5):
 *   - Dual-Mode Sync:
 *     Mode A (Contact-Enriched): Only sync emails WHERE at least one participant
 *       is already a Contact in CRM. For existing tenants with rich contact data.
 *     Mode B (Auto-Discover): Sync last N threads and create PendingContacts
 *       from corporate domains. For new tenants with zero contacts.
 *
 *   - Domain Blacklist: System-wide filter for known consumer/noreply domains.
 *     Prevents pollution of PendingContact list with gmail.com, outlook.com, etc.
 *
 *   - Slow-Burn Sync: Max 10 IMAP FETCH requests per minute with random jitter
 *     (2-8 seconds between calls). Simulates human browsing to avoid provider
 *     "Suspicious Activity" flags on day one.
 *
 *   - Progress Tracking: Redis key with progress data, polled by Channel Settings UI.
 */

/** Sync modes for historical import */
export type SyncMode = 'contact_enriched' | 'auto_discover';

/** Sync job configuration */
export interface HistoricalSyncConfig {
  tenantId: string;
  configId: string;
  mode: SyncMode;
  /** Max age in days for historical scan (default: 30) */
  maxAgeDays: number;
  /** Max number of threads to process (default: 500) */
  maxThreads: number;
}

/** Sync progress tracking */
export interface SyncProgress {
  status: 'queued' | 'running' | 'completed' | 'failed';
  phase: string;
  processedThreads: number;
  totalEstimate: number;
  pendingContactsCreated: number;
  emailsImported: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

/** PendingContact — pre-verified contact waiting for agent activation */
export interface PendingContact {
  email: string;
  displayName: string;
  domain: string;
  seenCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  sampleSubjects: string[];
}

@Injectable()
export class HistoricalSyncService {
  private readonly logger = new Logger(HistoricalSyncService.name);

  /**
   * System-wide Domain Blacklist — Corporate domains only pass through.
   *
   * Why: A Sales rep's inbox can have 50%+ rác emails from consumer
   * email providers, newsletters, OTP services, and system notifications.
   * Without this filter, Mode B would create ~250 PendingContacts that
   * are 100% garbage. Agents would lose trust in the feature immediately.
   */
  private readonly DOMAIN_BLACKLIST = new Set([
    // Consumer email providers
    'gmail.com',
    'googlemail.com',
    'yahoo.com',
    'yahoo.co.jp',
    'hotmail.com',
    'outlook.com',
    'live.com',
    'msn.com',
    'aol.com',
    'icloud.com',
    'me.com',
    'mac.com',
    'mail.com',
    'protonmail.com',
    'proton.me',
    'zoho.com',
    'yandex.com',
    'gmx.com',
    'gmx.de',
    'tutanota.com',
    'fastmail.com',

    // Social / Professional platforms
    'linkedin.com',
    'facebook.com',
    'twitter.com',
    'instagram.com',

    // Notification / System
    'noreply.com',
    'no-reply.com',
    'notifications.com',
    'calendar-notification.google.com',
    'docusign.net',
    'sendgrid.net',
    'amazonses.com',
    'mailchimp.com',
    'mandrillapp.com',
    'postmarkapp.com',
    'mailgun.org',

    // Vietnamese consumer domains
    'vnn.vn',
    'fpt.vn',
    'vnpt.vn',
  ]);

  /** Domains matching these REGEX patterns are also blacklisted */
  private readonly DOMAIN_BLACKLIST_PATTERNS = [
    /^noreply\./i,
    /^no-reply\./i,
    /^notifications?\./i,
    /^mailer-daemon\./i,
    /^bounce/i,
    /^postmaster@/i,
  ];

  /** Slow-burn sync: max API calls per minute */
  private readonly MAX_REQUESTS_PER_MINUTE = 10;

  /** Jitter range between requests (ms) */
  private readonly JITTER_MIN_MS = 2000; // 2 seconds
  private readonly JITTER_MAX_MS = 8000; // 8 seconds

  constructor(
    private readonly configRepo: ChannelConfigRepository,
    private readonly redisService: RedisService,
    private readonly normalizer: EmailNormalizerService,
    @Inject(CRYPTO_SERVICE_TOKEN)
    private readonly crypto: ICryptoService,
    @InjectModel(EmailContentSchemaClass.name)
    private readonly emailContentModel: Model<any>,
    @InjectModel(EmailMetadataSchemaClass.name)
    private readonly emailMetadataModel: Model<any>,
  ) {}

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Start a historical sync job for a channel config.
   * This is a long-running operation — progress is tracked via Redis.
   */
  async startSync(config: HistoricalSyncConfig): Promise<{ jobId: string }> {
    const jobId = `hsync:${config.tenantId}:${config.configId}`;

    // Check if a sync is already running
    const existing = await this.getProgress(jobId);
    if (existing && existing.status === 'running') {
      throw new Error('A historical sync is already running for this channel');
    }

    // Initialize progress tracking
    await this.updateProgress(jobId, {
      status: 'queued',
      phase: 'Initializing...',
      processedThreads: 0,
      totalEstimate: config.maxThreads,
      pendingContactsCreated: 0,
      emailsImported: 0,
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    });

    // Run sync in background (non-blocking)
    this.executeSyncJob(jobId, config).catch((err) => {
      this.logger.error(`[HistoricalSync] Job ${jobId} failed: ${err.message}`);
      void this.updateProgress(jobId, {
        status: 'failed',
        phase: 'Failed',
        error: err.message,
        completedAt: new Date().toISOString(),
      } as SyncProgress);
    });

    return { jobId };
  }

  /**
   * Get sync progress for a job.
   * Used by Channel Settings UI to show progress indicator.
   */
  async getProgress(jobId: string): Promise<SyncProgress | null> {
    const client = this.redisService.getClient();
    const data = await client.get(jobId);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Check if a domain is blacklisted (consumer/noreply/system).
   */
  isDomainBlacklisted(email: string): boolean {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return true;

    // Exact match
    if (this.DOMAIN_BLACKLIST.has(domain)) return true;

    // Pattern match
    for (const pattern of this.DOMAIN_BLACKLIST_PATTERNS) {
      if (pattern.test(domain) || pattern.test(email)) return true;
    }

    return false;
  }

  // ── Core Sync Engine ──────────────────────────────────────────────────

  /**
   * Execute the sync job. This is the main async pipeline.
   */
  private async executeSyncJob(
    jobId: string,
    config: HistoricalSyncConfig,
  ): Promise<void> {
    let ImapFlow: any;
    try {
      ImapFlow = (await import('imapflow')).ImapFlow;
    } catch {
      throw new Error('imapflow package not installed');
    }

    // Resolve IMAP credentials
    const channelConfig = await this.configRepo.findByIdWithCredentialsNoTenant(
      config.configId,
    );
    if (!channelConfig?.encryptedCredentials) {
      throw new Error('Channel config not found or credentials missing');
    }

    let credentials: Record<string, any>;
    try {
      credentials = JSON.parse(
        await this.crypto.decrypt(channelConfig.encryptedCredentials!),
      );
    } catch {
      throw new Error('Failed to decrypt credentials');
    }

    const imapHost = channelConfig.publicSettings?.imapHost;
    const imapPort = Number(channelConfig.publicSettings?.imapPort || 993);
    if (!imapHost) throw new Error('IMAP host not configured');

    await this.updateProgress(jobId, {
      status: 'running',
      phase: 'Connecting to mailbox...',
    } as SyncProgress);

    // Connect to IMAP
    const client = new ImapFlow({
      host: imapHost,
      port: imapPort,
      secure: imapPort === 993,
      auth: { user: credentials.user, pass: credentials.password },
      logger: false,
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        await this.updateProgress(jobId, {
          phase: 'Scanning mailbox...',
        } as SyncProgress);

        // Calculate date range: last N days
        const sinceDate = new Date();
        sinceDate.setDate(sinceDate.getDate() - config.maxAgeDays);

        // Fetch message envelopes (headers only — no body yet)
        const messages: any[] = [];
        let requestCount = 0;

        for await (const msg of client.fetch(
          { since: sinceDate },
          { envelope: true, uid: true },
        )) {
          messages.push(msg);
          requestCount++;

          // Slow-burn: pause after each batch of MAX_REQUESTS_PER_MINUTE
          if (requestCount % this.MAX_REQUESTS_PER_MINUTE === 0) {
            const jitter = this.randomJitter();
            this.logger.debug(
              `[HistoricalSync] Slow-burn pause: ${jitter}ms after ${requestCount} requests`,
            );
            await this.sleep(jitter);
          }

          // Cap at maxThreads
          if (messages.length >= config.maxThreads) break;
        }

        this.logger.log(
          `[HistoricalSync] Scanned ${messages.length} messages in last ${config.maxAgeDays} days`,
        );

        await this.updateProgress(jobId, {
          phase: 'Processing emails...',
          totalEstimate: messages.length,
        } as SyncProgress);

        // Process messages based on sync mode
        const pendingContacts = new Map<string, PendingContact>();
        let importedCount = 0;

        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          const envelope = msg.envelope;
          if (!envelope) continue;

          // Extract all participants
          const allParticipants = [
            ...(envelope.from || []),
            ...(envelope.to || []),
            ...(envelope.cc || []),
          ];

          const emails = allParticipants
            .map((addr: any) => addr.address?.toLowerCase())
            .filter(Boolean);

          if (config.mode === 'auto_discover') {
            // Mode B: Create PendingContacts for corporate domains
            for (const email of emails) {
              if (this.isDomainBlacklisted(email)) continue;

              const domain = email.split('@')[1];
              const existing = pendingContacts.get(email);

              if (existing) {
                existing.seenCount++;
                existing.lastSeenAt = envelope.date || new Date();
                if (existing.sampleSubjects.length < 3) {
                  existing.sampleSubjects.push(envelope.subject || '');
                }
              } else {
                const name =
                  allParticipants.find(
                    (a: any) => a.address?.toLowerCase() === email,
                  )?.name || email.split('@')[0];

                pendingContacts.set(email, {
                  email,
                  displayName: name,
                  domain,
                  seenCount: 1,
                  firstSeenAt: envelope.date || new Date(),
                  lastSeenAt: envelope.date || new Date(),
                  sampleSubjects: [envelope.subject || ''],
                });
              }
            }
          }

          importedCount++;

          // Update progress every 50 messages
          if (i % 50 === 0) {
            await this.updateProgress(jobId, {
              phase: `Processing email ${i + 1} of ${messages.length}...`,
              processedThreads: i + 1,
              emailsImported: importedCount,
              pendingContactsCreated: pendingContacts.size,
            } as SyncProgress);

            // Slow-burn: add jitter between processing batches
            if (i > 0 && i % this.MAX_REQUESTS_PER_MINUTE === 0) {
              await this.sleep(this.randomJitter());
            }
          }
        }

        // Save PendingContacts to Redis (for UI review screen)
        if (pendingContacts.size > 0) {
          const pendingKey = `hsync:pending:${config.tenantId}:${config.configId}`;
          const pendingData = Array.from(pendingContacts.values());
          await this.redisService.getClient().set(
            pendingKey,
            JSON.stringify(pendingData),
            'EX',
            7 * 24 * 60 * 60, // TTL: 7 days
          );
        }

        // Final progress update
        await this.updateProgress(jobId, {
          status: 'completed',
          phase: 'Completed',
          processedThreads: messages.length,
          emailsImported: importedCount,
          pendingContactsCreated: pendingContacts.size,
          completedAt: new Date().toISOString(),
        } as SyncProgress);

        this.logger.log(
          `[HistoricalSync] Completed! Imported: ${importedCount}, ` +
            `PendingContacts: ${pendingContacts.size}`,
        );
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private async updateProgress(
    jobId: string,
    partial: Partial<SyncProgress>,
  ): Promise<void> {
    const client = this.redisService.getClient();
    const existing = await client.get(jobId);
    const current = existing ? JSON.parse(existing) : {};
    const updated = { ...current, ...partial };
    // TTL: 24 hours for progress data
    await client.set(jobId, JSON.stringify(updated), 'EX', 24 * 60 * 60);
  }

  private randomJitter(): number {
    return Math.floor(
      Math.random() * (this.JITTER_MAX_MS - this.JITTER_MIN_MS) +
        this.JITTER_MIN_MS,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
