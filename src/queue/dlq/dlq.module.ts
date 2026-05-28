import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DlqService } from './dlq.service';
import { DlqProcessor } from './dlq.processor';
import { CRM_DLQ_QUEUE } from './dlq.constants';

/**
 * Global Dead Letter Queue module.
 *
 * Provides a centralized DLQ for all BullMQ queues.
 * When a job exhausts all retries, the consumer's onFailed hook
 * forwards the job metadata to this queue for auditing and alerting.
 */
@Global()
@Module({
  imports: [
    BullModule.registerQueue({
      name: CRM_DLQ_QUEUE,
      defaultJobOptions: {
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 2000 },
      },
    }),
  ],
  providers: [DlqService, DlqProcessor],
  exports: [DlqService],
})
export class DlqModule {}
