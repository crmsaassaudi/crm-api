import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CRM_DLQ_QUEUE } from './dlq.constants';

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
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Forward a failed job to the DLQ for auditing.
   * This should be called only after all retries have been exhausted.
   *
   * - Adds a deterministic jobId so a retried DLQ-write does not create
   *   duplicate DLQ records.
   * - Emits `dlq.recorded` so the observability / alerting layer can fan
   *   the event out to Slack/PagerDuty without coupling DLQ to those.
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

      const dlqJobId = `dlq:${sourceQueue}:${job.id ?? 'unknown'}`;
      await this.dlqQueue.add(`dlq:${sourceQueue}:${job.name}`, dlqData, {
        jobId: dlqJobId,
        removeOnComplete: { count: 5_000, age: 60 * 60 * 24 * 30 },
        removeOnFail: { count: 10_000 },
      });

      this.logger.warn(
        `[DLQ] Job ${job.id} from [${sourceQueue}] forwarded to DLQ after ${job.attemptsMade} attempts: ${error.message}`,
      );

      // Decouple DLQ persistence from alerting. The alert handler can
      // batch/throttle by sourceQueue (e.g. page only if > 10 in 5min).
      this.eventEmitter.emit('dlq.recorded', dlqData);
    } catch (dlqError: any) {
      // DLQ itself failed — log but don't throw to avoid crashing the consumer
      this.logger.error(
        `[DLQ] Failed to forward job ${job.id} to DLQ: ${dlqError.message}`,
      );
    }
  }
}
