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

      // email_metadata links by messageId, not conversationId, so this cannot
      // scope precisely to this conversation's emails — it syncs all of this
      // config's unsynchronized emails instead.
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
        .limit(50)
        .lean();

      if (emailsToSync.length === 0) {
        this.logger.debug(
          `[ReadStateSync] No emails to sync for conversation ${conversationId}`,
        );
        return;
      }

      const jobs: ReadStateSyncJobData[] = emailsToSync.map((meta: any) => ({
        tenantId,
        configId,
        conversationId,
        emailMessageId: meta.emailMessageId,
        imapUid: meta.imapUid,
        targetState,
      }));

      const messageIds = emailsToSync.map((m: any) => m.emailMessageId);
      await this.emailMetadataModel.updateMany(
        { emailMessageId: { $in: messageIds } },
        { $set: { syncStatus: 'pending' } },
      );

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
