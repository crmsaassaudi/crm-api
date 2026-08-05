import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
  AUTOMATION_ACTION_DLQ,
  AUTOMATION_BULK_QUEUE,
  AUTOMATION_EMAIL_QUEUE,
  AUTOMATION_SMS_QUEUE,
  AUTOMATION_INTERNAL_QUEUE,
  AUTOMATION_WEBHOOK_QUEUE,
  AUTOMATION_DELAYED_QUEUE,
  AUTOMATION_TRIGGER_QUEUE,
} from './automation-queue.constants';

/**
 * Registers BullMQ queues for the automation engine.
 *
 * No queue-level `limiter` anywhere: a limiter is per queue, which means per
 * platform, so it throttles every tenant collectively and lets one busy tenant
 * delay everyone else. Channel credentials are per tenant too, so there is no
 * shared provider account for a global limit to protect.
 *
 * Fairness and spend ceilings are per tenant, in {@link AutomationQuotaService}.
 * Worker concurrency is set on each @Processor.
 */
@Module({
  imports: [
    // Trigger evaluation — keeps workflow matching off the API event loop
    BullModule.registerQueue({
      name: AUTOMATION_TRIGGER_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 500,
        removeOnFail: 2000,
      },
    }),

    BullModule.registerQueue({
      name: AUTOMATION_EMAIL_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: 200,
        removeOnFail: 1000,
      },
    }),

    BullModule.registerQueue({
      name: AUTOMATION_SMS_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 1000,
      },
    }),

    // DB-only actions: update_field, route_to_group, create_*, tags, notes
    BullModule.registerQueue({
      name: AUTOMATION_INTERNAL_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 200,
        removeOnFail: 1000,
      },
    }),

    BullModule.registerQueue({
      name: AUTOMATION_WEBHOOK_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 1000,
      },
    }),

    // Dead Letter Queue — manual retry only
    BullModule.registerQueue({
      name: AUTOMATION_ACTION_DLQ,
      defaultJobOptions: {
        removeOnComplete: 500,
        removeOnFail: 2000,
      },
    }),

    // Bulk queue — throttled high-volume events
    BullModule.registerQueue({
      name: AUTOMATION_BULK_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 1000,
      },
    }),

    // Delayed resume queue — Wait/Delay node hibernation.
    //
    // `removeOnFail` is generous and `attempts` is 3 because a lost resume is a
    // workflow that silently stops halfway, days after the user set it up. The
    // durable row in `automation_delayed_jobs` is the record of record.
    BullModule.registerQueue({
      name: AUTOMATION_DELAYED_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 100,
        removeOnFail: 2000,
      },
    }),
  ],
  exports: [BullModule],
})
export class AutomationQueueModule {}
