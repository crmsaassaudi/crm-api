import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AUTOMATION_BULK_QUEUE } from './automation-queue.constants';
import { AutomationEventPayload } from '../events/automation-event.payload';

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
    workflow: any;
    payload: AutomationEventPayload;
  }): Promise<void> {
    const job = await this.bulkQueue.add('automation.bulk-execute', data, {
      priority: 10, // Low priority
    });

    this.logger.log(
      `[Bulk] Queued throttled event: job=${job.id} workflow=${data.workflow._id} record=${data.payload.recordId}`,
    );
  }
}
