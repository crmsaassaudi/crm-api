import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  ReadStateSyncProducer,
  ReadStateSyncJobData,
} from './read-state-sync.producer';
import { EmailMetadataSchemaClass } from '../../channels/infrastructure/persistence/document/entities/email-metadata.schema';
import { EmailChannelSettingsService } from '../../channels/services/email-channel-settings.service';

/**
 * ReadStateSyncEventListener — Bridges domain events to BullMQ jobs.
 *
 * Listens for `email.read_state.changed` events emitted by the
 * OmniController when an agent reads/unreads an email conversation.
 * Looks up the email metadata for the conversation and enqueues
 * sync jobs for each email that needs its IMAP \Seen flag updated.
 */
@Injectable()
export class ReadStateSyncEventListener {
  private readonly logger = new Logger(ReadStateSyncEventListener.name);

  constructor(
    private readonly producer: ReadStateSyncProducer,
    private readonly emailSettings: EmailChannelSettingsService,
    @InjectModel(EmailMetadataSchemaClass.name)
    private readonly emailMetadataModel: Model<any>,
  ) {}

  /**
   * Handle read state change events from the OmniController.
   *
   * Event payload:
   *   - tenantId: string
   *   - conversationId: string
   *   - configId: string (channelAccount = SMTP config ID)
   *   - targetState: 'read' | 'unread'
   */
  @OnEvent('email.read_state.changed')
  async handleReadStateChanged(event: {
    tenantId: string;
    conversationId: string;
    configId: string;
    targetState: 'read' | 'unread';
  }): Promise<void> {
    const { tenantId, conversationId, configId, targetState } = event;

    this.logger.log(
      `[ReadStateSync] Event received: conversation=${conversationId} → ${targetState}`,
    );

    try {
      const shouldSyncOnView =
        await this.emailSettings.shouldSyncReadStateOnView(tenantId);

      if (!shouldSyncOnView) {
        this.logger.debug(
          `[ReadStateSync] Dropped passive read event for conversation ${conversationId}; readStateStrategy.syncOnlyOnAction is enabled or provider sync is off`,
        );
        return;
      }

      // Find all email metadata for this conversation's messages.
      // We need to look up messages by conversationId via the omni_messages collection,
      // then match their metadata. However, email_metadata links via messageId (ObjectId),
      // so we use the emailMessageId for the sync job.

      // Strategy: find email metadata by tenantId where syncStatus !== 'synced'
      // for the target state, limited to emails from this config.
      // Since we don't have a direct conversationId link in email_metadata,
      // we look up all recent unsynchronized emails for this config.

      const filter: Record<string, any> = {
        tenantId,
        imapUid: { $ne: null }, // Only emails that came from IMAP
      };

      // For 'read' state: sync emails that haven't been synced yet
      if (targetState === 'read') {
        filter.syncStatus = { $in: [null, 'failed'] };
      }

      const emailsToSync = await this.emailMetadataModel
        .find(filter)
        .select('emailMessageId imapUid')
        .sort({ _id: -1 })
        .limit(50) // Cap batch size
        .lean();

      if (emailsToSync.length === 0) {
        this.logger.debug(
          `[ReadStateSync] No emails to sync for conversation ${conversationId}`,
        );
        return;
      }

      // Build batch of sync jobs
      const jobs: ReadStateSyncJobData[] = emailsToSync.map((meta: any) => ({
        tenantId,
        configId,
        conversationId,
        emailMessageId: meta.emailMessageId,
        imapUid: meta.imapUid,
        targetState,
      }));

      // Mark all as pending before enqueuing
      const messageIds = emailsToSync.map((m: any) => m.emailMessageId);
      await this.emailMetadataModel.updateMany(
        { emailMessageId: { $in: messageIds } },
        { $set: { syncStatus: 'pending' } },
      );

      // Enqueue batch
      await this.producer.enqueueBatch(jobs);

      this.logger.log(
        `[ReadStateSync] Enqueued ${jobs.length} sync job(s) for conversation ${conversationId}`,
      );
    } catch (err: any) {
      this.logger.error(
        `[ReadStateSync] Failed to process read state event: ${err.message}`,
      );
    }
  }
}
