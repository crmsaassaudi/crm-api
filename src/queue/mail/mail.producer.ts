import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class MailProducer {
  constructor(@InjectQueue('mail') private readonly mailQueue: Queue) {}

  async sendWelcomeEmail(email: string, name: string) {
    await this.mailQueue.add(
      'welcome-email',
      { email, name },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnFail: false, // Keep failed jobs for DLQ
      },
    );
  }
}
