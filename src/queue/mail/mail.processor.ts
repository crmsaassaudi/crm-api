import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { BaseConsumer } from '../base.consumer';
import { Inject, Logger, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';

const SENT_KEY_TTL_SECONDS = 86_400 * 7; // 7 days dedup window

@Processor('mail')
export class MailProcessor extends BaseConsumer {
  protected readonly logger = new Logger(MailProcessor.name);

  constructor(
    @Optional() @Inject(IOREDIS_CLIENT) private readonly redis?: Redis,
  ) {
    super();
  }

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
    const dedupKey = `mail:sent:welcome:${job.id}`;

    // Idempotency: SET NX so a retried/duplicated job is a no-op.
    if (this.redis) {
      const acquired = await this.redis.set(
        dedupKey,
        '1',
        'EX',
        SENT_KEY_TTL_SECONDS,
        'NX',
      );
      if (acquired !== 'OK') {
        this.logger.warn(
          `Welcome email already sent for job ${job.id} — skipping duplicate`,
        );
        return;
      }
    }

    this.logger.log(`Sending welcome email to ${job.data.email}...`);
    try {
      // Placeholder: inject MailerService and call sendWelcomeEmail(job.data)
      // when the mailer module is wired up to this processor.
      await Promise.resolve();
      this.logger.log(`Welcome email sent to ${job.data.email}`);
    } catch (err) {
      // Roll back dedup key so retry can re-attempt.
      if (this.redis) {
        await this.redis.del(dedupKey).catch(() => undefined);
      }
      throw err;
    }
  }
}
