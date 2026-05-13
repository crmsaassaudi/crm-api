import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  AUTOMATION_DELAYED_QUEUE,
  AutomationDelayedJobData,
  AutomationDelayedQueueJobData,
} from './automation-queue.constants';
import { AutomationDelayedJobRepository } from '../infrastructure/persistence/document/repositories/automation-delayed-job.repository';

const DEFAULT_HOT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_STALE_ENQUEUED_MS = 15 * 60 * 1000;
const DEFAULT_PROMOTION_LIMIT = 500;

/**
 * Stores Wait/Delay resume state in MongoDB and only promotes near-due jobs
 * into Redis. This keeps long-running cold jobs out of BullMQ delayed sets.
 */
@Injectable()
export class AutomationDelayedProducer {
  private readonly logger = new Logger(AutomationDelayedProducer.name);

  constructor(
    @InjectQueue(AUTOMATION_DELAYED_QUEUE)
    private readonly queue: Queue,
    private readonly delayedJobRepo: AutomationDelayedJobRepository,
  ) {}

  async scheduleResume(
    data: AutomationDelayedJobData,
    delayMs: number,
  ): Promise<string | undefined> {
    const resumeAt = new Date(Date.now() + Math.max(0, delayMs));
    const delayedJob = await this.delayedJobRepo.upsertPending(data, resumeAt);

    this.logger.log(
      `[Delayed] Stored cold resume: delayedJob=${delayedJob?._id} ` +
        `execution=${data.executionId} resumeFrom=${data.resumeFromNodeId} ` +
        `delay=${delayMs}ms resumeAt=${resumeAt.toISOString()}`,
    );

    await this.promoteDueJobs();

    return delayedJob?._id?.toString();
  }

  async promoteDueJobs(): Promise<number> {
    const hotWindowMs = this.readNumberEnv(
      'AUTOMATION_DELAYED_HOT_WINDOW_MS',
      DEFAULT_HOT_WINDOW_MS,
    );
    const staleEnqueuedMs = this.readNumberEnv(
      'AUTOMATION_DELAYED_STALE_ENQUEUED_MS',
      DEFAULT_STALE_ENQUEUED_MS,
    );
    const limit = this.readNumberEnv(
      'AUTOMATION_DELAYED_PROMOTION_LIMIT',
      DEFAULT_PROMOTION_LIMIT,
    );

    const now = Date.now();
    const dueJobs = await this.delayedJobRepo.claimDueForEnqueue({
      windowUntil: new Date(now + hotWindowMs),
      staleBefore: new Date(now - staleEnqueuedMs),
      limit,
    });

    let promoted = 0;
    for (const delayedJob of dueJobs) {
      const delay = Math.max(
        0,
        new Date(delayedJob.resumeAt).getTime() - Date.now(),
      );
      const payload: AutomationDelayedQueueJobData = {
        ...delayedJob.payload,
        delayedJobId: delayedJob._id.toString(),
      };

      try {
        await this.queue.add('delayed-resume', payload, {
          delay,
          jobId: delayedJob.jobKey,
          removeOnComplete: 100,
          removeOnFail: 500,
        });
        promoted++;
      } catch (error: any) {
        await this.delayedJobRepo.markPendingAfterEnqueueFailure(
          delayedJob._id.toString(),
          error.message,
        );
        this.logger.error(
          `[Delayed] Failed to enqueue hot resume job=${delayedJob.jobKey}: ${error.message}`,
          error.stack,
        );
      }
    }

    if (promoted > 0) {
      this.logger.log(`[Delayed] Promoted ${promoted} due job(s) to Redis`);
    }

    return promoted;
  }

  private readNumberEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
