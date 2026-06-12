import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  AUTOMATION_ACTION_QUEUE,
  AUTOMATION_EMAIL_QUEUE,
  AUTOMATION_SMS_QUEUE,
  AUTOMATION_INTERNAL_QUEUE,
  AUTOMATION_WEBHOOK_QUEUE,
  AutomationJobName,
  AutomationActionJobData,
} from './automation-queue.constants';
import { DEFAULT_JOB_OPTIONS } from '../../queue/config/default-job-options';

/**
 * AutomationActionProducer — dispatches action jobs to typed BullMQ queues.
 *
 * Phase 4: Routes each action to its dedicated queue for independent
 * rate limiting (email → email queue, sms → sms queue, etc.).
 *
 * Called by the WorkflowOrchestratorService after conditions evaluate to true.
 * Each action node in the workflow becomes a separate job.
 */
@Injectable()
export class AutomationActionProducer {
  private readonly logger = new Logger(AutomationActionProducer.name);

  /** Map action type → queue instance */
  private readonly queueMap: Map<string, Queue>;

  constructor(
    @InjectQueue(AUTOMATION_ACTION_QUEUE)
    private readonly mainQueue: Queue,
    @InjectQueue(AUTOMATION_EMAIL_QUEUE)
    private readonly emailQueue: Queue,
    @InjectQueue(AUTOMATION_SMS_QUEUE)
    private readonly smsQueue: Queue,
    @InjectQueue(AUTOMATION_INTERNAL_QUEUE)
    private readonly internalQueue: Queue,
    @InjectQueue(AUTOMATION_WEBHOOK_QUEUE)
    private readonly webhookQueue: Queue,
  ) {
    this.queueMap = new Map<string, Queue>([
      ['send_email', this.emailQueue],
      ['send_sms', this.smsQueue],
      ['update_field', this.internalQueue],
      ['route_to_team', this.internalQueue],
      ['webhook', this.webhookQueue],
    ]);
  }

  /**
   * Dispatch an action job to the appropriate typed queue.
   *
   * A deterministic `jobId` of `${executionId}:${nodeId}` is used so that
   * re-dispatching the same step within the same execution is idempotent —
   * BullMQ rejects a duplicate jobId, preventing the same action node from
   * being enqueued twice for one execution (CRIT-02).
   *
   * Manual retries (DLQ → main queue) must NOT be deduped against the
   * original failed job, so callers may pass an explicit `jobId` override
   * (e.g. with a retry suffix) via `opts`.
   */
  async dispatch(
    data: AutomationActionJobData,
    opts?: { jobId?: string },
  ): Promise<string | undefined> {
    const jobName = this.resolveJobName(data.actionType);
    const queue = this.queueMap.get(data.actionType) || this.mainQueue;

    const jobId = opts?.jobId ?? `${data.executionId}:${data.nodeId}`;

    const job = await queue.add(jobName, data, {
      ...DEFAULT_JOB_OPTIONS,
      jobId,
      // Priority: email/sms are higher priority than update-field
      priority: this.resolvePriority(data.actionType),
    });

    this.logger.log(
      `Dispatched job ${job.id} [${jobName}] → queue=${queue.name} workflow=${data.workflowId} node=${data.nodeId}`,
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
      case 'webhook':
        return AutomationJobName.WEBHOOK;
      default:
        return AutomationJobName.UPDATE_FIELD; // fallback to internal
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
      case 'webhook':
        return 4;
      default:
        return 5;
    }
  }
}
