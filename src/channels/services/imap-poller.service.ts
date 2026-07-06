import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { RedisLockService } from '../../redis/redis-lock.service';
import { RedisService } from '../../redis/redis.service';
import { BusinessHoursService } from '../../omni-inbound/services/business-hours.service';
import { EmailNormalizerService } from './email-normalizer.service';
import { ChannelConfigRepository } from '../infrastructure/persistence/document/repositories/channel-config.repository';
import { EmailContentSchemaClass } from '../infrastructure/persistence/document/entities/email-content.schema';
import { EmailMetadataSchemaClass } from '../infrastructure/persistence/document/entities/email-metadata.schema';
import { OmniMessageSchemaClass } from '../../omni-inbound/infrastructure/persistence/document/entities/omni-message.schema';
import { ICryptoService, CRYPTO_SERVICE_TOKEN } from '../domain/crypto.service';
import { EmailChannelSettingsService } from './email-channel-settings.service';

import { simpleParser, ParsedMail } from 'mailparser';
import { OAuth2TokenManager } from './oauth2-token-manager.service';
import { ClsService } from 'nestjs-cls';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import {
  isEmailWorkerRuntime,
  isWorkerRuntime,
} from '../../config/runtime-role';

type MailboxLabelContext = {
  crmFolder: string | null;
  providerFolder: string | null;
  providerLabelIds: string[];
  providerLabels: string[];
};

type ProviderLabelDetail = {
  id: string;
  name: string;
  type: 'system' | 'user';
  color: string | null;
};

/**
 * ImapPollerService — Enterprise email inbound engine.
 *
 * Architecture:
 *   - Scheduled via setInterval (not BullMQ cron, to support dynamic intervals)
 *   - Each tenant's SMTP config with IMAP fields triggers a polling job
 *   - Distributed Redis Lock prevents double-polling in multi-instance deploy
 *   - Dynamic Polling: Business-Hour-aware interval (2min active / 15min idle/off-hours)
 *   - Timezone-aware: reads tenant's Business Hours config, NOT hardcoded (GCC support)
 *
 * Flow:
 *   1. Scan all tenant SMTP configs with imapHost configured
 *   2. For each config: acquire Redis lock → connect IMAP → fetch UNSEEN → process
 *   3. EmailNormalizer filters auto-responders & bounces
 *   4. Clean emails → save to email_contents/email_metadata → emit to OmniInbound pipeline
 */
@Injectable()
export class ImapPollerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImapPollerService.name);
  private pollTimer: NodeJS.Timeout | null = null;
  /** Graceful shutdown flag — stops in-flight polling loops */
  private destroying = false;
  /**
   * Track in-flight poll promises so onModuleDestroy can wait for active
   * IMAP sessions to drain before the process exits. Without this, SIGTERM
   * during a poll leaves the mailbox lock held in Redis for LOCK_TTL_MS.
   */
  private readonly inFlightPolls = new Set<Promise<unknown>>();

  /** Active interval (within business hours + recent activity) */
  private readonly ACTIVE_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
  /** Idle interval (outside business hours or no recent activity) */
  private readonly IDLE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  /** Lock TTL: max time a single poll can take before lock expires */
  private readonly LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes (handles large batches)
  /** Max emails to process per poll cycle (rest will be caught next cycle) */
  private readonly MAX_BATCH_SIZE = 10;
  /** Hard cap for raw RFC822 parsing until attachment streaming is implemented. */
  private readonly MAX_RAW_EMAIL_BYTES = 15 * 1024 * 1024;
  /** Activity threshold: tenant is "idle" if no email in/out for 24h */
  private readonly ACTIVITY_THRESHOLD_MS = 24 * 60 * 60 * 1000;

  constructor(
    private readonly configRepo: ChannelConfigRepository,
    private readonly lockService: RedisLockService,
    private readonly redisService: RedisService,
    private readonly businessHoursService: BusinessHoursService,
    private readonly normalizer: EmailNormalizerService,
    private readonly emailSettings: EmailChannelSettingsService,
    private readonly oauth2TokenManager: OAuth2TokenManager,
    private readonly cls: ClsService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(CRYPTO_SERVICE_TOKEN)
    private readonly crypto: ICryptoService,
    @InjectModel(EmailContentSchemaClass.name)
    private readonly emailContentModel: Model<EmailContentSchemaClass>,
    @InjectModel(EmailMetadataSchemaClass.name)
    private readonly emailMetadataModel: Model<EmailMetadataSchemaClass>,
    @InjectModel(OmniMessageSchemaClass.name)
    private readonly omniMessageModel: Model<OmniMessageSchemaClass>,
  ) {}

  async onModuleInit() {
    // Only start IMAP polling in email-worker (or legacy monolith worker) process.
    // Prevents duplicate polling from api-service and omni-worker-service.
    if (isEmailWorkerRuntime() || isWorkerRuntime()) {
      await this.cleanupStaleLocks().catch((err) =>
        this.logger.error(
          `[ImapPoller] Failed to cleanup stale locks: ${err.message}`,
        ),
      );
      this.startScheduler();
    } else {
      this.logger.log('[ImapPoller] Skipped — not an email-worker process');
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.destroying = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.inFlightPolls.size > 0) {
      this.logger.log(
        `[ImapPoller] Waiting for ${this.inFlightPolls.size} in-flight poll(s) to finish…`,
      );
      // Cap the drain to 25s so k8s SIGKILL doesn't overlap.
      await Promise.race([
        Promise.allSettled(Array.from(this.inFlightPolls)),
        new Promise((resolve) => setTimeout(resolve, 25_000).unref()),
      ]);
    }

    this.logger.log('[ImapPoller] Destroyed — scheduler stopped');
  }

  /**
   * Wrap a poll task so it auto-registers / deregisters in inFlightPolls.
   * Use this around any async work that should be drained on shutdown.
   */
  private track<T>(task: Promise<T>): Promise<T> {
    this.inFlightPolls.add(task);
    void task.finally(() => this.inFlightPolls.delete(task));
    return task;
  }

  // ── Stale Lock Cleanup (hot-reload / crash recovery) ─────────────────────

  /**
   * On startup, delete any IMAP locks left by a previous process.
   * Since we're a fresh instance, no in-flight polls exist from THIS process.
   */
  private async cleanupStaleLocks(): Promise<void> {
    try {
      const client = this.redisService.getClient();
      let cursor = '0';
      let totalCleaned = 0;

      // Use SCAN instead of KEYS to avoid blocking the Redis event loop.
      // SCAN is O(1) per iteration and safe for production use.
      do {
        const reply = await client.scan(
          cursor,
          'MATCH',
          'imap:lock:*',
          'COUNT',
          100,
        );
        cursor = reply[0];
        const keys = reply[1];
        if (keys.length > 0) {
          await client.del(...keys);
          totalCleaned += keys.length;
        }
      } while (cursor !== '0');

      if (totalCleaned > 0) {
        this.logger.warn(
          `[ImapPoller] Cleaned up ${totalCleaned} stale lock(s) from previous instance`,
        );
      }
    } catch (err: any) {
      this.logger.error(
        `[ImapPoller] Failed to cleanup stale locks: ${err.message}`,
      );
    }
  }

  // ── Master Scheduler ────────────────────────────────────────────────────

  /**
   * Master tick: runs every minute, decides which tenants need polling.
   * This is NOT a per-tenant timer — it's a single scheduler that fans out.
   */
  private startScheduler(): void {
    // Run first tick after 30 seconds (let app bootstrap complete)
    setTimeout(() => this.masterTick(), 30_000);
    // Then every 60 seconds
    this.pollTimer = setInterval(() => this.masterTick(), 60_000);
    this.logger.log('[ImapPoller] Master scheduler started (60s tick)');
  }

  /**
   * Master tick: find all SMTP configs with IMAP enabled, check intervals.
   */
  private async masterTick(): Promise<void> {
    if (this.destroying) return;

    try {
      const imapConfigs = await this.findImapEnabledConfigs();

      if (imapConfigs.length === 0) {
        this.logger.log('[ImapPoller] Tick: No IMAP-enabled configs found');
        return;
      }

      this.logger.log(
        `[ImapPoller] Tick: ${imapConfigs.length} IMAP-enabled configs found`,
      );

      // Fan out: check each config's polling schedule
      await Promise.allSettled(
        imapConfigs.map((config) => this.checkAndPoll(config)),
      );
    } catch (err: any) {
      this.logger.error(`[ImapPoller] Master tick error: ${err.message}`);
    }
  }

  // ── Per-Tenant Polling Decision ─────────────────────────────────────────

  /**
   * Decide whether to poll this tenant's mailbox NOW.
   * Uses Redis to track last poll time and compare with dynamic interval.
   */
  private async checkAndPoll(config: any): Promise<void> {
    const cacheKey = `imap:lastpoll:${config.id}`;
    const client = this.redisService.getClient();

    // Check when we last polled this config
    const lastPollStr = await client.get(cacheKey);
    const lastPollMs = lastPollStr ? parseInt(lastPollStr, 10) : 0;

    // Determine interval based on business hours + activity
    const interval = await runWithTenantContext(this.cls, config.tenantId, () =>
      this.getDynamicInterval(config.tenantId),
    );

    // First poll ever for this config → run immediately; otherwise respect interval
    if (lastPollMs > 0) {
      const elapsed = Date.now() - lastPollMs;

      if (elapsed < interval) {
        this.logger.log(
          `[ImapPoller] ${config.name}: Skipping — next poll in ${Math.ceil((interval - elapsed) / 1000)}s`,
        );
        return;
      }
      this.logger.log(
        `[ImapPoller] ${config.name}: Interval elapsed (${Math.ceil(elapsed / 1000)}s >= ${Math.ceil(interval / 1000)}s) — polling now`,
      );
    } else {
      this.logger.log(
        `[ImapPoller] ${config.name}: First poll — running immediately`,
      );
    }

    // Time to poll — acquire distributed lock
    const lockKey = `imap:lock:${config.id}`;

    try {
      await this.lockService.acquire(
        lockKey,
        this.LOCK_TTL_MS,
        async () => {
          this.logger.log(
            `[ImapPoller] ${config.name}: Lock acquired — starting pollMailbox`,
          );
          await this.track(
            runWithTenantContext(this.cls, config.tenantId, () =>
              this.pollMailbox(config),
            ),
          );
          // Record poll time
          await client.set(cacheKey, Date.now().toString(), 'PX', interval * 2);
          this.logger.log(
            `[ImapPoller] ${config.name}: Poll complete — recorded lastPoll`,
          );
        },
        200, // retry delay
        3, // max retries (don't fight for locks)
      );
    } catch (err: any) {
      // Lock busy = another instance is polling this mailbox.
      if (err.message?.includes('Could not acquire lock')) {
        this.logger.warn(
          `[ImapPoller] ${config.name}: Could not acquire lock — another instance is polling`,
        );
        return;
      }
      this.logger.error(
        `[ImapPoller] Poll error for config ${config.name}: ${err.message}`,
      );
    }
  }

  /**
   * Dynamic Polling Interval — Timezone-aware, Business-Hours-aware.
   *
   * Strategy (from Product Researcher feedback):
   *   - Within business hours + active (email in last 24h): 2 minutes
   *   - Within business hours + idle: 15 minutes
   *   - Outside business hours: 15 minutes
   *   - Uses tenant's configured timezone (GCC/Saudi support)
   */
  private async getDynamicInterval(tenantId: string): Promise<number> {
    // Dev mode: always poll at active interval (skip business-hours check)
    if (process.env.NODE_ENV !== 'production') {
      return this.ACTIVE_INTERVAL_MS;
    }

    try {
      // Check business hours (uses tenant's timezone, NOT hardcoded)
      const isBusinessHours =
        await this.businessHoursService.isWithinBusinessHours(tenantId);

      if (!isBusinessHours) {
        return this.IDLE_INTERVAL_MS;
      }

      // Check recent activity
      const activityKey = `imap:activity:${tenantId}`;
      const client = this.redisService.getClient();
      const lastActivity = await client.get(activityKey);

      if (lastActivity) {
        const elapsed = Date.now() - parseInt(lastActivity, 10);
        if (elapsed < this.ACTIVITY_THRESHOLD_MS) {
          return this.ACTIVE_INTERVAL_MS; // Active tenant
        }
      }

      return this.IDLE_INTERVAL_MS; // Idle tenant
    } catch {
      return this.IDLE_INTERVAL_MS; // Default to idle on error
    }
  }

  /**
   * Record activity for a tenant (called when email is received or sent).
   * Resets the idle timer so polling stays at 2-minute intervals.
   */
  async recordActivity(tenantId: string): Promise<void> {
    const client = this.redisService.getClient();
    await client.set(
      `imap:activity:${tenantId}`,
      Date.now().toString(),
      'PX',
      this.ACTIVITY_THRESHOLD_MS,
    );
  }

  // ── IMAP Polling Logic ──────────────────────────────────────────────────

  /**
   * Connect to IMAP, fetch UNSEEN emails, process each through normalizer.
   */
  private async pollMailbox(config: any): Promise<void> {
    let ImapFlow: any;
    try {
      ImapFlow = (await import('imapflow')).ImapFlow;
    } catch {
      this.logger.error('[ImapPoller] imapflow package not installed.');
      return;
    }

    const credentials = await this.getImapCredentials(config);
    if (!credentials) return;

    const imapHost = config.publicSettings?.imapHost;
    const imapPort = Number(config.publicSettings?.imapPort || 993);
    if (!imapHost) return;

    const auth =
      (config.authType ?? 'app_password') === 'oauth2'
        ? { user: credentials.user, accessToken: credentials.accessToken }
        : { user: credentials.user, pass: credentials.password };

    const client = new ImapFlow({
      host: imapHost,
      port: imapPort,
      secure: imapPort === 993,
      auth,
      logger: false,
      socketTimeout: 30_000,
      greetingTimeout: 15_000,
    } as any);

    try {
      await client.connect();
      const syncTargetFolders = await this.emailSettings.getSyncTargetFolders(
        config.tenantId,
      );
      if (!syncTargetFolders.includes('INBOX')) {
        this.logger.debug(
          `[ImapPoller] ${config.name}: INBOX is not in syncTargetFolders; skipping`,
        );
        return;
      }

      const lock = await client.getMailboxLock('INBOX');
      try {
        await this.processInbox(client, config);
      } finally {
        lock.release();
      }
    } catch (err: any) {
      this.logger.error(
        `[ImapPoller] IMAP connection failed for ${config.name}: ${err.message}`,
      );
    } finally {
      await client.logout().catch(() => {});
    }
  }

  private async getImapCredentials(
    config: any,
  ): Promise<Record<string, any> | null> {
    try {
      let credentials = JSON.parse(
        await this.crypto.decrypt(config.encryptedCredentials),
      );
      credentials = await this.oauth2TokenManager.buildOAuth2Credentials(
        config,
        credentials,
      );
      return credentials;
    } catch (err: any) {
      this.logger.error(
        `[ImapPoller] Failed to decrypt credentials for ${config.name}: ${err.message}`,
      );
      return null;
    }
  }

  private async processInbox(client: any, config: any): Promise<void> {
    const uidCacheKey = `imap:lastuid:${config.id}`;
    const redisClient = this.redisService.getClient();
    const lastUidStr = await redisClient.get(uidCacheKey);
    const lastUid = lastUidStr ? parseInt(lastUidStr, 10) : 0;

    const initialSyncDays =
      parseInt(config.publicSettings?.initialSyncDays) || 30;
    const blockAutoResponders =
      config.publicSettings?.blockAutoResponders === true ||
      config.publicSettings?.blockAutoResponders === 'true';

    const fetchQuery =
      lastUid > 0
        ? { uid: `${lastUid + 1}:*` }
        : {
            since: new Date(Date.now() - initialSyncDays * 24 * 60 * 60 * 1000),
          };

    const messages: any[] = [];
    for await (const msg of client.fetch(fetchQuery, {
      envelope: true,
      source: true,
      bodyStructure: true,
      labels: true,
    })) {
      messages.push(msg);
      if (messages.length >= this.MAX_BATCH_SIZE) break;
    }

    if (messages.length === 0) return;

    this.logger.log(
      `[ImapPoller] ${config.name}: Found ${messages.length} new email(s)`,
    );
    await this.recordActivity(config.tenantId);

    let processed = 0;
    for (const msg of messages) {
      if (this.destroying) break;
      try {
        const gmailLabels = this.buildGmailLabelContext(msg.labels);
        await this.processEmail(config, msg, client, blockAutoResponders, {
          crmFolder: 'INBOX',
          providerFolder: 'INBOX',
          providerLabelIds: gmailLabels.providerLabelIds,
          providerLabels: gmailLabels.providerLabels,
        });
        processed++;
      } catch (err: any) {
        this.logger.error(
          `[ImapPoller] Failed to process email UID=${msg.uid}: ${err.message}`,
        );
      }
    }

    if (processed > 0) {
      this.logger.log(
        `[ImapPoller] ${config.name}: Successfully processed ${processed}/${messages.length} email(s)`,
      );
      const maxUid = Math.max(...messages.map((m: any) => m.uid));
      await redisClient.set(uidCacheKey, maxUid.toString());
    }
  }

  // ── Email Processing ────────────────────────────────────────────────────

  /**
   * Process a single fetched email through the normalizer pipeline.
   */
  private async processEmail(
    config: any,
    msg: any,
    _imapClient: any,
    blockAutoResponders: boolean = false,
    mailboxContext: MailboxLabelContext = {
      crmFolder: 'INBOX',
      providerFolder: 'INBOX',
      providerLabelIds: ['INBOX'],
      providerLabels: ['Inbox'],
    },
  ): Promise<void> {
    const envelopeMessageId = msg.envelope?.messageId;
    if (
      envelopeMessageId &&
      (await this.checkDuplicate(
        config.tenantId,
        envelopeMessageId,
        config,
        msg,
        mailboxContext,
      ))
    ) {
      return;
    }

    const rawSource = msg.source;
    if (!rawSource) {
      this.logger.warn(
        `[ImapPoller] UID=${msg.uid}: No source data — skipping`,
      );
      return;
    }

    const rawSize = Buffer.isBuffer(rawSource)
      ? rawSource.length
      : Buffer.byteLength(String(rawSource));
    if (rawSize > this.MAX_RAW_EMAIL_BYTES) {
      this.logger.warn(
        `[ImapPoller] UID=${msg.uid}: Raw email too large (${rawSize} bytes) - skipping`,
      );
      return;
    }

    const parsed = await this.parseEmail(rawSource, msg.uid, rawSize);
    const htmlBody = parsed.html || '';
    const textBody = parsed.text || '';
    const subject = parsed.subject || msg.envelope?.subject || '(no subject)';

    const { fromAddr, fromName, toAddrs, ccAddrs, bccAddrs } =
      this.extractParticipants(parsed);
    const headers = this.extractHeaders(parsed);

    if (
      blockAutoResponders &&
      this.normalizer.isAutoResponder(headers, blockAutoResponders)
    ) {
      this.logger.warn(`[ImapPoller] Dropped auto-responder: ${subject}`);
      return;
    }

    const bounce = this.normalizer.detectBounce(headers, textBody);
    if (bounce?.isBounce) {
      this.normalizer.handleBounce(
        config.tenantId,
        bounce.originalMessageId,
        bounce.reason,
      );
      return;
    }

    const threadInfo = this.normalizer.extractThreadInfo(headers);
    const rfcMessageId = threadInfo.messageId;
    if (
      rfcMessageId &&
      (await this.checkDuplicate(
        config.tenantId,
        rfcMessageId,
        config,
        msg,
        mailboxContext,
      ))
    ) {
      return;
    }

    const snippet = (textBody || '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 200);
    const generatedMessageId = new Types.ObjectId();

    const emailContent = await this.emailContentModel.create({
      tenantId: config.tenantId,
      messageId: generatedMessageId,
      contactIds: [],
      subject,
      htmlBody: htmlBody || '',
      textBody: textBody || '',
      attachments: [],
      from: fromAddr,
      to: toAddrs,
      cc: ccAddrs,
      rfc822MessageId: threadInfo.messageId || null,
    });

    const providerLabelDetails = this.buildProviderLabelDetails(mailboxContext);
    await this.saveEmailMetadata({
      config,
      generatedMessageId,
      threadInfo,
      fromAddr,
      toAddrs,
      ccAddrs,
      bccAddrs,
      mailboxContext,
      providerLabelDetails,
      imapUid: msg.uid,
      emailContent,
    });

    this.emitInboundEvents({
      config,
      generatedMessageId,
      fromAddr,
      fromName,
      toAddrs,
      ccAddrs,
      subject,
      snippet,
      threadInfo,
      emailContent,
      mailboxContext,
      providerLabelDetails,
      imapUid: msg.uid,
      date: parsed.date,
    });
  }

  private async checkDuplicate(
    tenantId: string,
    messageId: string,
    config: any,
    msg: any,
    mailboxContext: MailboxLabelContext,
  ): Promise<boolean> {
    const existing = await this.emailMetadataModel
      .findOne({ tenantId, emailMessageId: messageId })
      .lean();
    if (existing) {
      await this.refreshDuplicateEmailLabels(
        config,
        msg,
        existing,
        mailboxContext,
        messageId,
      );
      this.logger.warn(
        `[ImapPoller] UID=${msg.uid}: Skipped duplicate — ${messageId}`,
      );
      return true;
    }
    return false;
  }

  private async parseEmail(
    rawSource: any,
    msgUid: number,
    rawSize: number,
  ): Promise<ParsedMail> {
    this.logger.log(`[ImapPoller] UID=${msgUid}: Parsing (${rawSize} bytes)`);
    const parsePromise = simpleParser(rawSource, {
      skipImageLinks: true,
      skipHtmlToText: false,
      skipTextToHtml: false,
    });
    return await Promise.race([
      parsePromise,
      new Promise<ParsedMail>((_, reject) =>
        setTimeout(
          () => reject(new Error('simpleParser timed out after 30s')),
          30_000,
        ).unref(),
      ),
    ]);
  }

  private extractParticipants(parsed: ParsedMail) {
    const extractAddresses = (field: any): string[] => {
      if (!field) return [];
      const items = Array.isArray(field) ? field : [field];
      return items.flatMap((obj: any) =>
        (obj.value || []).map((a: any) => a.address).filter(Boolean),
      );
    };
    const fromAddr = parsed.from?.value?.[0]?.address ?? '';
    const fromName =
      parsed.from?.value?.[0]?.name || fromAddr.split('@')[0] || 'Unknown';
    return {
      fromAddr,
      fromName,
      toAddrs: extractAddresses(parsed.to),
      ccAddrs: extractAddresses(parsed.cc),
      bccAddrs: extractAddresses(parsed.bcc),
    };
  }

  private extractHeaders(parsed: ParsedMail): Record<string, string> {
    const headers: Record<string, string> = {};
    parsed.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (['from', 'to', 'cc', 'bcc', 'sender', 'reply-to'].includes(k)) {
        if (typeof value === 'object' && value !== null && 'text' in value) {
          headers[k] = (value as any).text;
        } else {
          headers[k] = String(value ?? '');
        }
      } else if (typeof value === 'string') {
        headers[k] = value;
      } else if (Array.isArray(value)) {
        headers[k] = value.join(', ');
      } else {
        headers[k] = String(value ?? '');
      }
    });
    return headers;
  }

  private async saveEmailMetadata(params: {
    config: any;
    generatedMessageId: Types.ObjectId;
    threadInfo: any;
    fromAddr: string;
    toAddrs: string[];
    ccAddrs: string[];
    bccAddrs: string[];
    mailboxContext: MailboxLabelContext;
    providerLabelDetails: any;
    imapUid: number;
    emailContent: any;
  }) {
    const {
      config,
      generatedMessageId,
      threadInfo,
      fromAddr,
      toAddrs,
      ccAddrs,
      bccAddrs,
      mailboxContext,
      providerLabelDetails,
      imapUid,
      emailContent,
    } = params;
    try {
      await this.emailMetadataModel.create({
        tenantId: config.tenantId,
        mailboxId: config.id,
        messageId: generatedMessageId,
        emailMessageId:
          threadInfo.messageId || `<imap-${generatedMessageId}@local>`,
        inReplyTo: threadInfo.inReplyTo,
        references: threadInfo.references,
        from: fromAddr,
        to: toAddrs,
        cc: ccAddrs,
        bcc: bccAddrs,
        crmFolder: mailboxContext.crmFolder,
        providerFolder: mailboxContext.providerFolder,
        providerLabelIds: mailboxContext.providerLabelIds,
        providerLabels: mailboxContext.providerLabels,
        providerLabelDetails,
        deliveryStatus: 'unknown',
        imapUid: imapUid || null,
      });
    } catch (err: any) {
      if (err.code === 11000) {
        await this.emailContentModel
          .deleteOne({ _id: emailContent._id })
          .catch(() => {});
        const messageId = threadInfo.messageId;
        if (messageId) {
          const existing = await this.emailMetadataModel
            .findOne({ tenantId: config.tenantId, emailMessageId: messageId })
            .lean();
          if (existing)
            await this.refreshDuplicateEmailLabels(
              config,
              { uid: imapUid },
              existing,
              mailboxContext,
              messageId,
            );
        }
        this.logger.debug(
          `[ImapPoller] Skipped duplicate (race): ${messageId}`,
        );
        return;
      }
      throw err;
    }
  }

  private emitInboundEvents(params: {
    config: any;
    generatedMessageId: Types.ObjectId;
    fromAddr: string;
    fromName: string;
    toAddrs: string[];
    ccAddrs: string[];
    subject: string;
    snippet: string;
    threadInfo: any;
    emailContent: any;
    mailboxContext: MailboxLabelContext;
    providerLabelDetails: any;
    imapUid: number;
    date?: Date;
  }) {
    const {
      config,
      generatedMessageId,
      fromAddr,
      fromName,
      toAddrs,
      ccAddrs,
      subject,
      snippet,
      threadInfo,
      emailContent,
      mailboxContext,
      providerLabelDetails,
      imapUid,
      date,
    } = params;
    this.eventEmitter.emit('email.inbound.received', {
      tenantId: config.tenantId,
      configId: config.id,
      channelType: 'email',
      generatedMessageId: generatedMessageId.toString(),
      from: fromAddr,
      fromName,
      to: toAddrs,
      cc: ccAddrs,
      subject,
      snippet,
      threadInfo,
      emailContentId: emailContent._id?.toString(),
      emailMetadataId: null, // Set in downstream if needed
      mailboxId: config.id,
      crmFolder: mailboxContext.crmFolder,
      providerFolder: mailboxContext.providerFolder,
      providerLabelIds: mailboxContext.providerLabelIds,
      providerLabels: mailboxContext.providerLabels,
      providerLabelDetails,
      imapUid: imapUid || null,
      timestamp: date || new Date(),
    });

    this.eventEmitter.emit('email.labels.observed', {
      tenantId: config.tenantId,
      mailboxId: config.id,
      provider: config.providerType,
      labels: providerLabelDetails,
    });
  }

  // ── Config Discovery ────────────────────────────────────────────────────

  private async refreshDuplicateEmailLabels(
    config: any,
    msg: any,
    existing: any,
    mailboxContext: MailboxLabelContext,
    messageIdForLog: string,
  ): Promise<void> {
    const providerLabelDetails = this.buildProviderLabelDetails(mailboxContext);
    const existingLabelIds = this.normalizeLabelSet(existing.providerLabelIds);
    const nextLabelIds = this.normalizeLabelSet(
      mailboxContext.providerLabelIds,
    );
    const labelsChanged = !this.sameStringArray(existingLabelIds, nextLabelIds);

    await this.emailMetadataModel
      .updateOne(
        { _id: existing._id },
        {
          $set: {
            mailboxId: existing.mailboxId || config.id,
            crmFolder: mailboxContext.crmFolder,
            providerFolder: mailboxContext.providerFolder,
            providerLabelIds: mailboxContext.providerLabelIds,
            providerLabels: mailboxContext.providerLabels,
            providerLabelDetails,
            imapUid: msg.uid || existing.imapUid || null,
          },
        },
      )
      .exec();

    await this.omniMessageModel
      .updateOne(
        {
          tenantId: config.tenantId,
          externalMessageId: existing.emailMessageId,
        },
        {
          $set: {
            'metadata.mailboxId': existing.mailboxId || config.id,
            'metadata.crmFolder': mailboxContext.crmFolder,
            'metadata.providerFolder': mailboxContext.providerFolder,
            'metadata.providerLabelIds': mailboxContext.providerLabelIds,
            'metadata.providerLabels': mailboxContext.providerLabels,
            'metadata.providerLabelDetails': providerLabelDetails,
          },
        },
      )
      .exec();

    const newlyObservedLabels = providerLabelDetails.filter(
      (label) => !existingLabelIds.includes(label.id),
    );
    if (newlyObservedLabels.length > 0) {
      this.eventEmitter.emit('email.labels.observed', {
        tenantId: config.tenantId,
        mailboxId: config.id,
        provider: config.providerType,
        labels: newlyObservedLabels,
      });
    }

    if (labelsChanged) {
      this.logger.log(
        `[ImapPoller] UID=${msg.uid}: Refreshed labels for duplicate ${messageIdForLog}`,
      );
    }
  }

  private buildProviderLabelDetails(
    mailboxContext: MailboxLabelContext,
  ): ProviderLabelDetail[] {
    return mailboxContext.providerLabelIds.map((id, index) => ({
      id,
      name: mailboxContext.providerLabels[index] || id,
      type: this.detectProviderLabelType(id),
      color: null,
    }));
  }

  private detectProviderLabelType(labelId: string): 'system' | 'user' {
    return [
      'INBOX',
      'SENT',
      'DRAFTS',
      'TRASH',
      'SPAM',
      'ARCHIVE',
      'UNREAD',
      'STARRED',
      'IMPORTANT',
    ].includes(labelId.toUpperCase())
      ? 'system'
      : 'user';
  }

  private normalizeLabelSet(labels?: string[]): string[] {
    return [...new Set((labels || []).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    );
  }

  private sameStringArray(left: string[], right: string[]): boolean {
    return (
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }

  private buildGmailLabelContext(labels?: Set<string>): {
    providerLabelIds: string[];
    providerLabels: string[];
  } {
    const rawLabels = labels ? Array.from(labels) : [];
    const normalized = rawLabels
      .map((label) => this.normalizeProviderLabel(label))
      .filter((label) => label.id && !label.id.startsWith('[Gmail]/'));

    if (!normalized.some((label) => label.id === 'INBOX')) {
      normalized.unshift({ id: 'INBOX', name: 'Inbox' });
    }

    return {
      providerLabelIds: normalized.map((label) => label.id),
      providerLabels: normalized.map((label) => label.name),
    };
  }

  private normalizeProviderLabel(label: string): { id: string; name: string } {
    const trimmed = String(label || '').trim();
    if (!trimmed) return { id: '', name: '' };

    if (trimmed === '\\Inbox' || trimmed.toUpperCase() === 'INBOX') {
      return { id: 'INBOX', name: 'Inbox' };
    }
    if (trimmed === '\\Sent' || trimmed.toUpperCase() === 'SENT') {
      return { id: 'SENT', name: 'Sent' };
    }
    if (trimmed === '\\Draft' || trimmed.toUpperCase() === 'DRAFTS') {
      return { id: 'DRAFTS', name: 'Drafts' };
    }
    if (trimmed === '\\Trash' || trimmed.toUpperCase() === 'TRASH') {
      return { id: 'TRASH', name: 'Trash' };
    }
    if (trimmed === '\\Junk' || trimmed.toUpperCase() === 'SPAM') {
      return { id: 'SPAM', name: 'Spam' };
    }

    const withoutSlash = trimmed.startsWith('\\') ? trimmed.slice(1) : trimmed;
    return { id: withoutSlash, name: withoutSlash };
  }

  /**
   * Find all SMTP channel configs that have IMAP sync enabled.
   * A config is IMAP-enabled if publicSettings.imapHost is non-empty.
   */
  private async findImapEnabledConfigs(): Promise<any[]> {
    try {
      // Use raw Mongoose query since repo doesn't have this filter
      const ChannelConfigModel =
        (this.configRepo as any)['configModel'] ||
        (this.configRepo as any).model;

      if (!ChannelConfigModel) {
        // Fallback: scan visible configs
        return [];
      }

      const configs = await ChannelConfigModel.find({
        providerType: 'smtp',
        deletedAt: null,
        status: 'active',
        'publicSettings.imapHost': { $exists: true, $ne: '' },
      })
        .select('+encryptedCredentials +accessToken +refreshToken')
        .setOptions({ isPlatformQuery: true } as any)
        .lean();

      // .lean() strips Mongoose virtuals — add `id` from `_id`
      return configs.map((c: any) => ({
        ...c,
        id: c._id?.toString(),
        tenantId: c.tenantId?.toString(),
      }));
    } catch (err: any) {
      this.logger.error(`[ImapPoller] Config scan error: ${err.message}`);
      return [];
    }
  }

  // ── Basic Email Parsers ─────────────────────────────────────────────────

  // parseHeaders and parseBody are now handled by mailparser in processEmail()
}
