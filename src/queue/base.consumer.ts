import { OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { DlqService } from './dlq/dlq.service';

export abstract class BaseConsumer extends WorkerHost {
  protected readonly logger = new Logger(BaseConsumer.name);

  @Optional()
  @Inject(DlqService)
  protected readonly dlqService?: DlqService;

  // Per-job lifecycle logging is `debug`, not `log`. At omni volumes these two
  // hooks alone emit two lines per message per queue stage; kept at info level
  // they dominate the log pipeline and add measurable latency to every job.
  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.debug(`Job ${job.id} completed. Name: ${job.name}.`);
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
    this.logger.debug(`Job ${job.id} started. Name: ${job.name}.`);
  }
}
