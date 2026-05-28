import { OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { DlqService } from './dlq/dlq.service';

export abstract class BaseConsumer extends WorkerHost {
  protected readonly logger = new Logger(BaseConsumer.name);

  @Optional()
  @Inject(DlqService)
  protected readonly dlqService?: DlqService;

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.log(`Job ${job.id} completed successfully. Name: ${job.name}.`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, error: Error) {
    this.logger.error(
      `Job ${job.id} failed. Name: ${job.name}. Error: ${error.message}. Stack: ${error.stack}`,
    );

    // Forward to DLQ if all retries exhausted
    const maxAttempts = job.opts?.attempts ?? 1;
    if (this.dlqService && job.attemptsMade >= maxAttempts) {
      await this.dlqService.sendToDlq(job.queueName, job, error);
    }
  }

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.log(`Job ${job.id} started. Name: ${job.name}.`);
  }
}
