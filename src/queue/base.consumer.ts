import { OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';

export abstract class BaseConsumer extends WorkerHost {
    protected readonly logger = new Logger(BaseConsumer.name);

    @OnWorkerEvent('completed')
    onCompleted(job: Job) {
        this.logger.log(
            `Job ${job.id} completed successfully. Name: ${job.name}. Data: ${JSON.stringify(
                job.data,
            )}`,
        );
    }

    @OnWorkerEvent('failed')
    onFailed(job: Job, error: Error) {
        this.logger.error(
            `Job ${job.id} failed. Name: ${job.name}. Error: ${error.message}. Stack: ${error.stack}`,
        );
    }

    @OnWorkerEvent('active')
    onActive(job: Job) {
        this.logger.log(`Job ${job.id} started. Name: ${job.name}.`);
    }
}
