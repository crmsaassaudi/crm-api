import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { BaseConsumer } from '../base.consumer';
import { Logger } from '@nestjs/common';

@Processor('mail')
export class MailProcessor extends BaseConsumer {
    protected readonly logger = new Logger(MailProcessor.name);

    async process(job: Job<any, any, string>): Promise<any> {
        switch (job.name) {
            case 'welcome-email':
                await this.sendWelcomeEmail(job);
                break;
            default:
                throw new Error(`Unknown job name: ${job.name}`);
        }
    }

    private async sendWelcomeEmail(job: Job) {
        // Idempotency check: Ensure email hasn't been sent already
        // In a real scenario, check a 'SentEmails' collection or Redis key
        // const isSent = await this.checkIfEmailSent(job.id);
        // if (isSent) return;

        this.logger.log(`Sending welcome email to ${job.data.email}...`);
        // Simulate email sending delay
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Simulate random failure for testing retry
        if (Math.random() < 0.1) {
            throw new Error('Random email sending failure');
        }

        this.logger.log(`Welcome email sent to ${job.data.email}`);
    }
}
