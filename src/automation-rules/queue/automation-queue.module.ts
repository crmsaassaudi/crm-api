import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AUTOMATION_ACTION_QUEUE } from './automation-queue.constants';

/**
 * Registers the BullMQ queue for automation action jobs.
 *
 * Each action node in a workflow dispatches a job to this queue.
 * Executors (Email, SMS, UpdateField, RouteToTeam) consume these jobs.
 *
 * Mirrors the pattern from SlaQueueModule and OmniQueueModule.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: AUTOMATION_ACTION_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: 200,
        removeOnFail: 1000,
      },
    }),
  ],
  exports: [BullModule],
})
export class AutomationQueueModule {}
