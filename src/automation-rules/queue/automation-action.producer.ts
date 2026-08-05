import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  AUTOMATION_EMAIL_QUEUE,
  AUTOMATION_SMS_QUEUE,
  AUTOMATION_INTERNAL_QUEUE,
  AUTOMATION_WEBHOOK_QUEUE,
  AutomationActionJobData,
  AutomationActionType,
  resolveQueueForAction,
  resolveJobNameForAction,
} from './automation-queue.constants';
import { DEFAULT_JOB_OPTIONS } from '../../queue/config/default-job-options';

/**
 * AutomationActionProducer — dispatches action jobs to typed BullMQ queues.
 *
 * Routes each action to its dedicated queue so email, SMS and webhook traffic
 * are rate-limited independently of each other.
 */
@Injectable()
export class AutomationActionProducer {
  private readonly logger = new Logger(AutomationActionProducer.name);

  private readonly queuesByName: Record<string, Queue>;

  constructor(
    @InjectQueue(AUTOMATION_EMAIL_QUEUE) emailQueue: Queue,
    @InjectQueue(AUTOMATION_SMS_QUEUE) smsQueue: Queue,
    @InjectQueue(AUTOMATION_INTERNAL_QUEUE) internalQueue: Queue,
    @InjectQueue(AUTOMATION_WEBHOOK_QUEUE) webhookQueue: Queue,
  ) {
    this.queuesByName = {
      [AUTOMATION_EMAIL_QUEUE]: emailQueue,
      [AUTOMATION_SMS_QUEUE]: smsQueue,
      [AUTOMATION_INTERNAL_QUEUE]: internalQueue,
      [AUTOMATION_WEBHOOK_QUEUE]: webhookQueue,
    };
  }

  /**
   * Dispatch an action job.
   *
   * A deterministic `jobId` of `${executionId}:${nodeId}` makes re-dispatching
   * the same step within one execution a no-op at the queue level. Manual
   * retries must NOT be deduped against the original failed job, so the retry
   * endpoint passes an explicit `jobId`.
   */
  async dispatch(
    data: AutomationActionJobData,
    opts?: { jobId?: string },
  ): Promise<string | undefined> {
    const jobName = resolveJobNameForAction(data.actionType);
    const queue = this.queuesByName[resolveQueueForAction(data.actionType)];

    const job = await queue.add(jobName, data, {
      ...DEFAULT_JOB_OPTIONS,
      jobId: opts?.jobId ?? `${data.executionId}:${data.nodeId}`,
      priority: PRIORITY_BY_ACTION[data.actionType],
    });

    this.logger.log(
      `Dispatched job ${job.id} [${jobName}] → queue=${queue.name} workflow=${data.workflowId} node=${data.nodeId}`,
    );

    return job.id;
  }
}

/**
 * BullMQ priority per action type (lower runs first).
 *
 * Customer-visible messages outrank internal bookkeeping, and outbound HTTP —
 * the slowest and least urgent — goes last.
 */
const PRIORITY_BY_ACTION: Record<AutomationActionType, number> = {
  send_email: 1,
  send_sms: 1,
  send_livechat: 1,
  route_to_group: 2,
  internal_notification: 2,
  update_field: 3,
  add_tag: 3,
  remove_tag: 3,
  add_note: 3,
  create_task: 4,
  create_ticket: 4,
  create_record: 4,
  webhook: 5,
  http_request: 5,
};
