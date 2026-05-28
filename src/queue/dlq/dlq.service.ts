import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import { CRM_DLQ_QUEUE } from './dlq.module';

export interface DlqJobData {
  sourceQueue: string;
  jobId: string;
  jobName: string;
  originalData: any;
  error: string;
  stack?: string;
  attemptsMade: number;
  failedAt: string;
}

/**
 * Service to forward permanently failed jobs to the Dead Letter Queue.
 *
 * Usage:
 * ```ts
 * // In BaseConsumer.onFailed() or any catch block:
 * await this.dlqService.sendToDlq('my-queue', job, error);
 * ```
 */
@Injectable()
export class DlqService {
  private readonly logger = new Logger(DlqService.name);

  constructor(
    @InjectQueue(CRM_DLQ_QUEUE)
    private readonly dlqQueue: Queue,
  ) {}

  /**
   * Forward a failed job to the DLQ for auditing.
   * This should be called only after all retries have been exhausted.
   */
  async sendToDlq(
    sourceQueue: string,
    job: Job,
    error: Error,
  ): Promise<void> {
    try {
      const dlqData: DlqJobData = {
        sourceQueue,
        jobId: job.id ?? 'unknown',
        jobName: job.name,
        originalData: job.data,
        error: error.message,
        stack: error.stack,
        attemptsMade: job.attemptsMade,
        failedAt: new Date().toISOString(),
      };

      await this.dlqQueue.add(
        `dlq:${sourceQueue}:${job.name}`,
        dlqData,
      );

      this.logger.warn(
        `[DLQ] Job ${job.id} from [${sourceQueue}] forwarded to DLQ after ${job.attemptsMade} attempts: ${error.message}`,
      );
    } catch (dlqError: any) {
      // DLQ itself failed — log but don't throw to avoid crashing the consumer
      this.logger.error(
        `[DLQ] Failed to forward job ${job.id} to DLQ: ${dlqError.message}`,
      );
    }
  }
}
