import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SLA_BREACH_QUEUE } from './sla-queue.constants';

/**
 * Registers the BullMQ queue for SLA breach-check delayed jobs.
 *
 * Each conversation with an SLA policy gets a single delayed job scheduled
 * for exactly `slaDeadlineMs` after creation. If the agent responds before
 * the deadline, the job is cancelled — zero DB polling.
 *
 * Mirrors the pattern established by OmniQueueModule / OMNI_AUTO_RESOLVE_QUEUE.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: SLA_BREACH_QUEUE,
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
export class SlaQueueModule {}
