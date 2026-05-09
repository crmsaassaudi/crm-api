import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, Inject } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { BaseConsumer } from '../base.consumer';
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
export class ReadStateSyncProcessor extends BaseConsumer {
  protected readonly logger = new Logger(ReadStateSyncProcessor.name);

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
  ) {
    super();
  }

  async process(job: Job<ReadStateSyncJobData>): Promise<void> {
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
    const { configId, emailMessageId, imapUid, targetState } = data;

    // ── Step 3: Check credentials and active status ───────────────────
    if (!config.encryptedCredentials) {
      this.logger.error(
        `[ReadStateSync] Credentials missing for config ${configId} — dropping job`,
      );
      await this.updateSyncStatus(
        emailMessageId,
        'failed',
        'Credentials missing',
      );
      return;
    }

    // Check if config is still active
    if (config.status === 'error' || config.status === 'disabled') {
      this.logger.warn(
        `[ReadStateSync] Config ${configId} is ${config.status} — dropping job`,
      );
      await this.updateSyncStatus(
        emailMessageId,
        'failed',
        `Config status: ${config.status}`,
      );
      return;
    }

    let credentials: Record<string, any>;
    try {
      credentials = JSON.parse(
        await this.crypto.decrypt(config.encryptedCredentials!),
      );
    } catch (err: any) {
      this.logger.error(
        `[ReadStateSync] Failed to decrypt credentials for ${configId}: ${err.message}`,
      );
      await this.updateSyncStatus(
        emailMessageId,
        'failed',
        'Credential decryption failed',
      );
      return;
    }

    // ── Step 4: Connect to IMAP ──────────────────────────────────────
    const imapHost = config.publicSettings?.imapHost;
    const imapPort = Number(config.publicSettings?.imapPort || 993);

    if (!imapHost) {
      this.logger.error(
        `[ReadStateSync] No IMAP host configured for ${configId}`,
      );
      await this.updateSyncStatus(
        emailMessageId,
        'failed',
        'IMAP host not configured',
      );
      return;
    }

    let ImapFlow: any;
    try {
      ImapFlow = (await import('imapflow')).ImapFlow;
    } catch {
      this.logger.error(
        '[ReadStateSync] imapflow package not installed. Run: npm install imapflow',
      );
      throw new Error('imapflow package not installed');
    }

    const client = new ImapFlow({
      host: imapHost,
      port: imapPort,
      secure: imapPort === 993,
      auth: {
        user: credentials.user,
        pass: credentials.password,
      },
      logger: false,
    });

    try {
      await client.connect();
      const mailboxLock = await client.getMailboxLock('INBOX');

      try {
        // ── Step 5: Resolve target UID ────────────────────────────────
        let targetUid = imapUid;

        if (!targetUid) {
          // UID not available — search by Message-ID header (UID validity fallback)
          targetUid = await this.searchByMessageId(client, emailMessageId);
        }

        if (!targetUid) {
          this.logger.warn(
            `[ReadStateSync] Could not find UID for ${emailMessageId} — dropping`,
          );
          await this.updateSyncStatus(
            emailMessageId,
            'failed',
            'Email not found in mailbox',
          );
          return;
        }

        // ── Step 6: Execute flag mutation ─────────────────────────────
        if (targetState === 'read') {
          await client.messageFlagsAdd({ uid: targetUid }, ['\\Seen']);
          this.logger.log(
            `[ReadStateSync] ✅ Marked as READ: UID=${targetUid} (${emailMessageId})`,
          );
        } else {
          await client.messageFlagsRemove({ uid: targetUid }, ['\\Seen']);
          this.logger.log(
            `[ReadStateSync] ✅ Marked as UNREAD: UID=${targetUid} (${emailMessageId})`,
          );
        }

        // ── Step 7: Update sync status ────────────────────────────────
        await this.updateSyncStatus(emailMessageId, 'synced', null);
      } finally {
        mailboxLock.release();
      }
    } catch (err: any) {
      // ── Step 8: Error classification ────────────────────────────────
      const classified = classifyProviderError(err);

      if (classified.severity === ErrorSeverity.PERMANENT) {
        // Auth error: DO NOT RETRY — halt processing
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

        // Don't throw — BullMQ would retry. We want to drop permanently.
        return;
      }

      // Transient error: let BullMQ retry with exponential backoff
      this.logger.warn(
        `[ReadStateSync] TRANSIENT error for ${emailMessageId}: ${classified.code} — retrying`,
      );
      await this.updateSyncStatus(
        emailMessageId,
        'pending',
        `Retry: ${classified.code}`,
      );

      throw err; // Re-throw so BullMQ retries
    } finally {
      await client.logout().catch(() => {});
    }
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
      const cleanId = messageId.replace(/^<|>$/g, '');

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
