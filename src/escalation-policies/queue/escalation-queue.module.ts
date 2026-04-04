import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ESCALATION_QUEUE } from './escalation-queue.constants';

/**
 * Registers the BullMQ queue for escalation delayed jobs.
 *
 * When an SLA breach is detected, escalation policies schedule delayed
 * jobs that fire X minutes later to perform actions like:
 *   - 5 min after breach: mark conversation with red highlight
 *   - 15 min after breach: notify/tag team leader
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: ESCALATION_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    }),
  ],
  exports: [BullModule],
})
export class EscalationQueueModule {}
