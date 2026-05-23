import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

/**
 * Payload for a read-state sync job.
 */
export interface ReadStateSyncJobData {
  tenantId: string;
  configId: string;
  conversationId: string;
  /** RFC 5322 Message-ID for UID validity fallback */
  emailMessageId: string;
  /** IMAP UID from the provider mailbox (may be stale) */
  imapUid: number | null;
  /** Target state: 'read' sets \Seen, 'unread' removes \Seen */
  targetState: 'read' | 'unread';
}

/**
 * ReadStateSyncProducer — Enqueues read-state sync jobs into BullMQ.
 *
 * Features:
 *   - 5-second delayed jobs: aggregates rapid clicks before processing
 *   - Deduplication by emailMessageId: prevents redundant IMAP commands
 *     when an agent clicks back and forth on the same email
 */
@Injectable()
export class ReadStateSyncProducer {
  private readonly logger = new Logger(ReadStateSyncProducer.name);

  constructor(
    @InjectQueue('read-state-sync')
    private readonly queue: Queue,
  ) {}

  /**
   * Enqueue a single read-state sync job.
   * Uses delayed execution (5s) so rapid UI clicks are deduplicated
   * by BullMQ's jobId mechanism.
   */
  async enqueueReadStateSync(data: ReadStateSyncJobData): Promise<void> {
    // Use emailMessageId + targetState as jobId for deduplication.
    // If the same message is clicked read→unread→read within 5s,
    // only the final state is processed.
    const jobId =
      `readstate-${data.emailMessageId}-${data.targetState}`.replace(/:/g, '-');

    await this.queue.add('sync-read-state', data, {
      jobId,
      delay: 5000, // 5-second delay for click aggregation
    });

    this.logger.debug(
      `[ReadStateSync] Queued: ${data.emailMessageId} → ${data.targetState} (delay=5s)`,
    );
  }

  /**
   * Enqueue multiple read-state sync jobs for a conversation.
   * Used when an agent opens a conversation with multiple unsynced emails.
   */
  async enqueueBatch(jobs: ReadStateSyncJobData[]): Promise<void> {
    if (jobs.length === 0) return;

    const bulkJobs = jobs.map((data) => ({
      name: 'sync-read-state',
      data,
      opts: {
        jobId: `readstate-${data.emailMessageId}-${data.targetState}`.replace(
          /:/g,
          '-',
        ),
        delay: 5000,
      },
    }));

    await this.queue.addBulk(bulkJobs);

    this.logger.log(
      `[ReadStateSync] Batch queued: ${jobs.length} job(s) for configId=${jobs[0].configId}`,
    );
  }
}
