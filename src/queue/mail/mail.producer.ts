import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash } from 'crypto';

@Injectable()
export class MailProducer {
  constructor(@InjectQueue('mail') private readonly mailQueue: Queue) {}

  async sendWelcomeEmail(email: string, name: string) {
    // Deterministic jobId so a webhook/event replay does not queue the
    // same welcome email twice. The processor also has a Redis SET NX guard
    // as a second layer of defence.
    const jobId =
      'welcome-' +
      createHash('sha256')
        .update(`${email}|${name}`)
        .digest('hex')
        .slice(0, 32);

    await this.mailQueue.add(
      'welcome-email',
      { email, name },
      {
        jobId,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: { count: 500, age: 60 * 60 * 24 },
        removeOnFail: { count: 1000, age: 60 * 60 * 24 * 7 },
      },
    );
  }
}
