import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  AUTOMATION_TRIGGER_QUEUE,
  AutomationTriggerJobData,
} from './automation-queue.constants';
import { AutomationEventPayload } from '../events/automation-event.payload';
import { DEFAULT_JOB_OPTIONS } from '../../queue/config/default-job-options';

/**
 * Hands a CRM event to the trigger-evaluation queue.
 *
 * The event listener used to call the orchestrator directly, which put workflow
 * matching and DAG traversal on the API's event loop. This enqueue is the only
 * work the request path now does.
 *
 * Note on durability: the enqueue still happens after the DB commit, so a crash
 * in that window loses the event. Closing it needs a transactional outbox in each
 * CRM service — the pattern `AssignmentOutboxPublisherService` already uses. This
 * is the smaller half of that fix: once a job is in the queue it survives a
 * worker restart, is retried, and dead-letters visibly instead of vanishing.
 */
@Injectable()
export class AutomationTriggerProducer {
  private readonly logger = new Logger(AutomationTriggerProducer.name);

  constructor(
    @InjectQueue(AUTOMATION_TRIGGER_QUEUE)
    private readonly queue: Queue,
  ) {}

  async enqueue(payload: AutomationEventPayload): Promise<void> {
    const data: AutomationTriggerJobData = {
      eventId: payload.eventId,
      tenantId: payload.tenantId,
      event: payload.event,
      object: payload.object,
      recordId: payload.recordId,
      data: payload.data,
      changedFields: payload.changedFields,
      automationDepth: payload.automationDepth,
      automationBreadcrumbs: payload.automationBreadcrumbs,
      _automationSourceWorkflowId: payload._automationSourceWorkflowId,
      triggerUserId: payload.triggerUserId,
    };

    await this.queue.add(`${payload.event}.${payload.object}`, data, {
      ...DEFAULT_JOB_OPTIONS,
      // Stable only for an outbox event. Genuine updates each receive a unique
      // ULID, while replay after a publisher crash collapses to the same job.
      ...(payload.eventId
        ? { jobId: `automation-event-${payload.eventId}` }
        : {}),
    });

    this.logger.debug(
      `[Trigger] Queued ${payload.event}.${payload.object} ` +
        `tenant=${payload.tenantId} record=${payload.recordId}`,
    );
  }
}
