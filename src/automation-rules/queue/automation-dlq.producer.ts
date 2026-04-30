import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  AUTOMATION_ACTION_DLQ,
  AutomationActionJobData,
} from './automation-queue.constants';

/**
 * AutomationDlqProducer — sends exhausted jobs to the Dead Letter Queue.
 *
 * Called by the main action processor when a job has exhausted all retries.
 * The DLQ processor logs these and marks the step as 'dlq' in the execution log.
 */
@Injectable()
export class AutomationDlqProducer {
  private readonly logger = new Logger(AutomationDlqProducer.name);

  constructor(
    @InjectQueue(AUTOMATION_ACTION_DLQ)
    private readonly dlqQueue: Queue,
  ) {}

  async sendToDlq(
    data: AutomationActionJobData,
    failedReason: string,
  ): Promise<void> {
    await this.dlqQueue.add('automation.dlq', {
      ...data,
      failedReason,
      failedAt: new Date().toISOString(),
    });

    this.logger.warn(
      `[DLQ] Job sent to DLQ: workflow=${data.workflowId} node=${data.nodeId} reason=${failedReason}`,
    );
  }
}
