import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  AUTOMATION_BULK_QUEUE,
  AutomationBulkJobData,
} from './automation-queue.constants';
import { AutomationEventPayload } from '../events/automation-event.payload';
import { BACKGROUND_JOB_OPTIONS } from '../../queue/config/default-job-options';

/**
 * AutomationBulkProducer — dispatches throttled events to the low-priority bulk queue.
 *
 * Used by the Event Listener when the token-bucket rate limiter detects
 * > 1000 events/second for a tenant (e.g., CSV Import of 50k records).
 */
@Injectable()
export class AutomationBulkProducer {
  private readonly logger = new Logger(AutomationBulkProducer.name);

  constructor(
    @InjectQueue(AUTOMATION_BULK_QUEUE)
    private readonly bulkQueue: Queue,
  ) {}

  async dispatch(data: {
    workflowId: string;
    payload: AutomationEventPayload;
  }): Promise<void> {
    const jobData: AutomationBulkJobData = {
      // Top-level tenantId is the BaseTenantConsumer contract — see
      // AutomationBulkJobData. Without it the consumer throws before handle().
      tenantId: data.payload.tenantId,
      workflowId: data.workflowId,
      payload: data.payload as AutomationBulkJobData['payload'],
    };

    const job = await this.bulkQueue.add('automation.bulk-execute', jobData, {
      // BACKGROUND_JOB_OPTIONS is DEFAULT plus a longer backoff and two more
      // attempts, written for exactly this ("low-priority/background jobs that can
      // tolerate retries") and until now used by nobody. Safe here because the
      // deterministic jobId below makes a retry idempotent.
      ...BACKGROUND_JOB_OPTIONS,
      priority: 10, // Low priority
      // Deterministic id: the same workflow evaluating the same record for the
      // same event is one unit of work, so a duplicate emission collapses
      // instead of queueing a second execution.
      jobId: `bulk:${data.payload.tenantId}:${data.workflowId}:${data.payload.event}:${data.payload.recordId}`,
    });

    this.logger.log(
      `[Bulk] Queued throttled event: job=${job.id} workflow=${data.workflowId} record=${data.payload.recordId}`,
    );
  }
}
