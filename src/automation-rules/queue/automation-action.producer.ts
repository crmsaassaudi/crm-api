import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  AUTOMATION_ACTION_QUEUE,
  AutomationJobName,
  AutomationActionJobData,
} from './automation-queue.constants';

/**
 * AutomationActionProducer — dispatches action jobs to the BullMQ queue.
 *
 * Called by the WorkflowOrchestratorService after conditions evaluate to true.
 * Each action node in the workflow becomes a separate job.
 */
@Injectable()
export class AutomationActionProducer {
  private readonly logger = new Logger(AutomationActionProducer.name);

  constructor(
    @InjectQueue(AUTOMATION_ACTION_QUEUE)
    private readonly queue: Queue,
  ) {}

  /**
   * Dispatch an action job to the queue.
   */
  async dispatch(data: AutomationActionJobData): Promise<string | undefined> {
    const jobName = this.resolveJobName(data.actionType);

    const job = await this.queue.add(jobName, data, {
      // Priority: email/sms are higher priority than update-field
      priority: this.resolvePriority(data.actionType),
    });

    this.logger.log(
      `Dispatched job ${job.id} [${jobName}] for workflow=${data.workflowId} node=${data.nodeId}`,
    );

    return job.id;
  }

  /**
   * Dispatch multiple action jobs in bulk (e.g., parallel action nodes).
   */
  async dispatchBulk(
    jobs: AutomationActionJobData[],
  ): Promise<(string | undefined)[]> {
    const results = await Promise.all(jobs.map((job) => this.dispatch(job)));
    return results;
  }

  private resolveJobName(actionType: string): AutomationJobName {
    switch (actionType) {
      case 'send_email':
        return AutomationJobName.SEND_EMAIL;
      case 'send_sms':
        return AutomationJobName.SEND_SMS;
      case 'update_field':
        return AutomationJobName.UPDATE_FIELD;
      case 'route_to_team':
        return AutomationJobName.ROUTE_TO_TEAM;
      default:
        return AutomationJobName.SEND_EMAIL; // fallback
    }
  }

  private resolvePriority(actionType: string): number {
    // Lower number = higher priority in BullMQ
    switch (actionType) {
      case 'send_email':
        return 1;
      case 'send_sms':
        return 1;
      case 'route_to_team':
        return 2;
      case 'update_field':
        return 3;
      default:
        return 5;
    }
  }
}
