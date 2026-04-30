import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  AUTOMATION_DELAYED_QUEUE,
  AutomationDelayedJobData,
} from './automation-queue.constants';

/**
 * AutomationDelayedProducer — schedules delayed resume jobs for Wait/Delay nodes.
 *
 * When the DAG Orchestrator encounters a Wait node, it:
 *   1. Serializes minimal execution state (no record snapshot — re-fetch on resume)
 *   2. Calls scheduleResume() with the computed delay
 *   3. Stops traversal — BullMQ handles the timer
 *
 * When the delay expires, BullMQ auto-dequeues the job and the
 * AutomationDelayedProcessor resumes traversal from the next node.
 */
@Injectable()
export class AutomationDelayedProducer {
  private readonly logger = new Logger(AutomationDelayedProducer.name);

  constructor(
    @InjectQueue(AUTOMATION_DELAYED_QUEUE)
    private readonly queue: Queue,
  ) {}

  /**
   * Schedule a delayed resume job.
   *
   * @param data - Minimal state needed to resume (no record data — will re-fetch)
   * @param delayMs - Delay in milliseconds before the job becomes active
   */
  async scheduleResume(
    data: AutomationDelayedJobData,
    delayMs: number,
  ): Promise<string | undefined> {
    // Idempotent job ID — prevents duplicate scheduling
    const jobId = `resume-${data.executionId}-${data.resumeFromNodeId}`;

    const job = await this.queue.add('delayed-resume', data, {
      delay: delayMs,
      jobId,
      removeOnComplete: 100,
      removeOnFail: 500,
    });

    const resumeAt = new Date(Date.now() + delayMs).toISOString();
    this.logger.log(
      `[Delayed] Scheduled resume: job=${job.id} execution=${data.executionId} ` +
        `resumeFrom=${data.resumeFromNodeId} delay=${delayMs}ms resumeAt=${resumeAt}`,
    );

    return job.id;
  }
}
