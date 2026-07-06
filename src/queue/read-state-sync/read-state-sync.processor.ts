import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, Inject } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';

import { BaseTenantConsumer } from '../base-tenant.consumer';
import { ReadStateSyncJobData } from './read-state-sync.producer';
import { ChannelConfigRepository } from '../../channels/infrastructure/persistence/document/repositories/channel-config.repository';
import {
  ICryptoService,
  CRYPTO_SERVICE_TOKEN,
} from '../../channels/domain/crypto.service';
import { EmailChannelSettingsService } from '../../channels/services/email-channel-settings.service';
import { RedisLockService } from '../../redis/redis-lock.service';
import {
  classifyProviderError,
  ErrorSeverity,
} from '../../channels/domain/error-classifier';
import { EmailMetadataSchemaClass } from '../../channels/infrastructure/persistence/document/entities/email-metadata.schema';

/**
 * ReadStateSyncProcessor — BullMQ worker for Two-Way Read State Sync.
 *
 * Processes `sync-read-state` jobs emitted when an agent reads/unreads
 * an email in the CRM UI. Sets or removes the IMAP \Seen flag on the
 * provider's mailbox (Gmail/Outlook).
 *
 * Fail-safes:
 *   - Opt-in check: drops job if syncReadState is disabled
 *   - Redis lock: prevents concurrent processing of the same message
 *   - UID Validity fallback: searches by Message-ID header if UID is stale
 *   - Error classification: auth errors → halt (no retry), transient → retry 3×
 *   - Sync status tracking: updates email_metadata.syncStatus for debugging
 */
@Processor('read-state-sync')
export class ReadStateSyncProcessor extends BaseTenantConsumer<ReadStateSyncJobData> {
  protected readonly logger = new Logger(ReadStateSyncProcessor.name);
  protected readonly cls: ClsService;

  /** Redis lock TTL for per-message sync operations */
  private readonly LOCK_TTL_MS = 30_000; // 30 seconds

  constructor(
    private readonly configRepo: ChannelConfigRepository,
    private readonly emailSettings: EmailChannelSettingsService,
    @Inject(CRYPTO_SERVICE_TOKEN)
    private readonly crypto: ICryptoService,
    private readonly lockService: RedisLockService,
    @InjectModel(EmailMetadataSchemaClass.name)
    private readonly emailMetadataModel: Model<any>,
    cls: ClsService,
  ) {
    super();
    this.cls = cls;
  }

  protected async handle(job: Job<ReadStateSyncJobData>): Promise<void> {
    const { emailMessageId, targetState } = job.data;

    this.logger.log(
      `[ReadStateSync] Processing: ${emailMessageId} → ${targetState} (attempt ${job.attemptsMade + 1})`,
    );

    // ── Step 1: Retrieve config & check opt-in ────────────────────────
    const config = await this.configRepo.findByIdWithCredentialsNoTenant(
      job.data.configId,
    );
    if (!config) {
      this.logger.error(
        `[ReadStateSync] Config ${job.data.configId} not found — dropping job`,
      );
      return;
    }

    const tenantReadStateEnabled =
      await this.emailSettings.isSyncReadStateEnabled(job.data.tenantId);
    const configReadStateEnabled =
      config.publicSettings?.syncReadState !== false &&
      config.publicSettings?.syncReadState !== 'false';
    if (!tenantReadStateEnabled || !configReadStateEnabled) {
      this.logger.debug(
        `[ReadStateSync] Dropped: read-state sync disabled for tenant or config ${config.name}`,
      );
      return;
    }

    // ── Step 2: Redis lock (prevent concurrent sync of same message) ──
    const lockKey = `readstate:lock:${emailMessageId}`;

    await this.lockService.acquire(
      lockKey,
      this.LOCK_TTL_MS,
      async () => {
        await this.executeSync(job.data, config);
      },
      200, // retry delay
      5, // max retries for lock
    );
  }

  /**
   * Core sync logic — runs inside Redis lock.
   */
  private async executeSync(
    data: ReadStateSyncJobData,
    config: any,
  ): Promise<void> {
    const { configId, emailMessageId } = data;

    const credentials = await this.loadAndDecryptCredentials(config);
    if (!credentials) return; // Status already updated in helper

    const client = await this.createImapClient(config, credentials);
    if (!client) return; // Status already updated

    try {
      await client.connect();
      const mailboxLock = await client.getMailboxLock('INBOX');

      try {
        await this.performMutation(client, data);
      } finally {
        mailboxLock.release();
      }
    } catch (err: any) {
      await this.handleSyncError(configId, emailMessageId, err);
    } finally {
      await client.logout().catch(() => {});
    }
  }

  private async loadAndDecryptCredentials(
    config: any,
  ): Promise<Record<string, any> | null> {
    const configId = String(config._id);
    if (!config.encryptedCredentials) {
      this.logger.error(`Credentials missing for config ${configId}`);
      return null;
    }

    if (config.status === 'error' || config.status === 'disabled') {
      this.logger.warn(`Config ${configId} is ${config.status}`);
      return null;
    }

    try {
      return JSON.parse(await this.crypto.decrypt(config.encryptedCredentials));
    } catch (err: any) {
      this.logger.error(
        `Failed to decrypt credentials for ${configId}: ${err.message}`,
      );
      return null;
    }
  }

  private async createImapClient(
    config: any,
    credentials: any,
  ): Promise<any | null> {
    const imapHost = config.publicSettings?.imapHost;
    const imapPort = Number(config.publicSettings?.imapPort ?? 993);

    if (!imapHost) {
      this.logger.error(`No IMAP host for ${config._id}`);
      return null;
    }

    const { ImapFlow } = await import('imapflow');
    return new ImapFlow({
      host: imapHost,
      port: imapPort,
      secure: imapPort === 993,
      auth: { user: credentials.user, pass: credentials.password },
      logger: false,
    });
  }

  private async performMutation(
    client: any,
    data: ReadStateSyncJobData,
  ): Promise<void> {
    const { emailMessageId, imapUid, targetState } = data;
    let targetUid = imapUid;

    if (!targetUid) {
      targetUid = await this.searchByMessageId(client, emailMessageId);
    }

    if (!targetUid) {
      await this.updateSyncStatus(emailMessageId, 'failed', 'Email not found');
      return;
    }

    if (targetState === 'read') {
      await client.messageFlagsAdd({ uid: targetUid }, ['\\Seen']);
    } else {
      await client.messageFlagsRemove({ uid: targetUid }, ['\\Seen']);
    }

    await this.updateSyncStatus(emailMessageId, 'synced', null);
  }

  private async handleSyncError(
    configId: string,
    emailMessageId: string,
    err: any,
  ): Promise<void> {
    const classified = classifyProviderError(err);
    if (classified.severity === ErrorSeverity.PERMANENT) {
      await this.handlePermanentError(configId, emailMessageId, classified);
      return;
    }

    await this.updateSyncStatus(
      emailMessageId,
      'pending',
      `Retry: ${classified.code}`,
    );
    throw err;
  }

  /**
   * Handle a permanent (non-retryable) provider error:
   * marks the config as invalid and drops the job without throwing.
   */
  private async handlePermanentError(
    configId: string,
    emailMessageId: string,
    classified: ReturnType<typeof classifyProviderError>,
  ): Promise<void> {
    this.logger.error(
      `[ReadStateSync] PERMANENT error for ${emailMessageId}: ${classified.code} — ${classified.message}`,
    );

    if (classified.shouldUpdateConfigStatus) {
      // Mark config as invalid to prevent further sync attempts
      await this.configRepo.updateHealthStatus(configId, {
        status: 'error',
        lastHealthError: `Read state sync auth failure: ${classified.message}`,
        consecutiveFailures: 99, // Force error state
      });
      this.logger.error(
        `[ReadStateSync] Config ${configId} marked as ERROR due to auth failure`,
      );
    }

    await this.updateSyncStatus(
      emailMessageId,
      'failed',
      `${classified.code}: ${classified.message}`,
    );
  }

  /**
   * UID Validity Fallback — Search for an email by its RFC 5322 Message-ID header.
   * IMAP UIDs can change if the mailbox is rebuilt or UIDValidity changes.
   * This ensures we always target the correct email.
   */
  private async searchByMessageId(
    client: any,
    messageId: string,
  ): Promise<number | null> {
    try {
      // Clean the message ID — remove angle brackets if present
      const cleanId = messageId.replace(/^</, '').replace(/>$/, '');

      const results = await client.search({
        header: { 'message-id': cleanId },
      });

      if (results && results.length > 0) {
        this.logger.debug(
          `[ReadStateSync] Message-ID search found UID=${results[0]} for ${messageId}`,
        );
        return results[0];
      }

      return null;
    } catch (err: any) {
      this.logger.warn(
        `[ReadStateSync] Message-ID search failed for ${messageId}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Update the syncStatus and lastSyncError fields in email_metadata.
   * Used for debugging and preventing duplicate sync attempts.
   */
  private async updateSyncStatus(
    emailMessageId: string,
    status: 'pending' | 'synced' | 'failed',
    error: string | null,
  ): Promise<void> {
    try {
      await this.emailMetadataModel.updateOne(
        { emailMessageId },
        {
          $set: {
            syncStatus: status,
            lastSyncError: error,
          },
        },
      );
    } catch (err: any) {
      this.logger.warn(
        `[ReadStateSync] Failed to update sync status for ${emailMessageId}: ${err.message}`,
      );
    }
  }
}
