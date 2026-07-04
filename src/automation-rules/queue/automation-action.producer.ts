import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  AUTOMATION_ACTION_QUEUE,
  AUTOMATION_EMAIL_QUEUE,
  AUTOMATION_SMS_QUEUE,
  AUTOMATION_INTERNAL_QUEUE,
  AUTOMATION_WEBHOOK_QUEUE,
  AutomationActionJobData,
  resolveQueueForAction,
  resolveJobNameForAction,
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
    // Build queue map from canonical resolveQueueForAction() — single source of truth.
    // This ensures all 16 action types route to the correct typed queue.
    const queueNameToInstance: Record<string, Queue> = {
      [AUTOMATION_EMAIL_QUEUE]: this.emailQueue,
      [AUTOMATION_SMS_QUEUE]: this.smsQueue,
      [AUTOMATION_INTERNAL_QUEUE]: this.internalQueue,
      [AUTOMATION_WEBHOOK_QUEUE]: this.webhookQueue,
    };

    const allActionTypes = [
      'send_email',
      'send_sms',
      'update_field',
      'route_to_team',
      'webhook',
      'create_task',
      'create_ticket',
      'add_tag',
      'remove_tag',
      'add_note',
      'create_record',
      'http_request',
      'send_whatsapp',
      'send_zns',
      'send_livechat',
      'internal_notification',
    ];

    this.queueMap = new Map<string, Queue>();
    for (const actionType of allActionTypes) {
      const queueName = resolveQueueForAction(actionType);
      this.queueMap.set(
        actionType,
        queueNameToInstance[queueName] ?? this.mainQueue,
      );
    }
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
    const jobName = resolveJobNameForAction(data.actionType);
    const queue = this.queueMap.get(data.actionType) || this.mainQueue;

    const jobId = opts?.jobId ?? `${data.executionId}:${data.nodeId}`;

    const job = await queue.add(jobName, data, {
      ...DEFAULT_JOB_OPTIONS,
      jobId,
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

  private resolvePriority(actionType: string): number {
    // Lower number = higher priority in BullMQ
    switch (actionType) {
      case 'send_email':
      case 'send_sms':
      case 'send_whatsapp':
      case 'send_zns':
      case 'send_livechat':
        return 1;
      case 'route_to_team':
      case 'internal_notification':
        return 2;
      case 'update_field':
      case 'add_tag':
      case 'remove_tag':
      case 'add_note':
        return 3;
      case 'create_task':
      case 'create_ticket':
      case 'create_record':
        return 4;
      case 'webhook':
      case 'http_request':
        return 5;
      default:
        return 5;
    }
  }
}
