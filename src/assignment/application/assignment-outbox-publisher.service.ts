import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AssignmentOutboxEventDocument,
  AssignmentOutboxEventSchemaClass,
} from '../infrastructure/persistence/assignment-outbox-event.schema';
import { MetricsService } from '../../observability/metrics.service';

const MAX_RETRIES = 10;

@Injectable()
export class AssignmentOutboxPublisherService {
  private readonly logger = new Logger(AssignmentOutboxPublisherService.name);

  constructor(
    @InjectModel(AssignmentOutboxEventSchemaClass.name)
    private readonly outbox: Model<AssignmentOutboxEventDocument>,
    private readonly events: EventEmitter2,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  @Cron('*/5 * * * * *')
  async publishPending(): Promise<number> {
    const candidates = await this.outbox
      .find({
        $or: [
          { status: 'pending' },
          {
            status: 'publishing',
            updatedAt: { $lt: new Date(Date.now() - 2 * 60_000) },
          },
        ],
        retryCount: { $lt: MAX_RETRIES },
      })
      .sort({ createdAt: 1 })
      .limit(100)
      .lean()
      .setOptions({ isPlatformQuery: true })
      .exec();
    let published = 0;
    for (const candidate of candidates) {
      const claimed = await this.outbox
        .findOneAndUpdate(
          {
            _id: candidate._id,
            status: candidate.status,
            retryCount: candidate.retryCount,
          },
          { $set: { status: 'publishing' } },
          { new: true },
        )
        .setOptions({ isPlatformQuery: true })
        .lean()
        .exec();
      if (!claimed) continue;
      try {
        await this.events.emitAsync(claimed.eventType, claimed.payload);
        await this.outbox
          .updateOne(
            { _id: claimed._id, status: 'publishing' },
            {
              $set: { status: 'published', publishedAt: new Date() },
            },
          )
          .setOptions({ isPlatformQuery: true });
        this.metrics?.incrementCounter(
          'crm_assignment_outbox_published_total',
          { eventType: claimed.eventType },
        );
        published++;
      } catch (error: any) {
        const nextRetry = (claimed.retryCount ?? 0) + 1;
        await this.outbox
          .updateOne(
            { _id: claimed._id, status: 'publishing' },
            {
              $set: {
                status: nextRetry >= MAX_RETRIES ? 'failed' : 'pending',
                lastError: error.message,
              },
              $inc: { retryCount: 1 },
            },
          )
          .setOptions({ isPlatformQuery: true });
        this.metrics?.incrementCounter(
          'crm_assignment_outbox_publish_failures_total',
          {
            eventType: claimed.eventType,
            terminal: String(nextRetry >= MAX_RETRIES),
          },
        );
        this.logger.error(
          `Assignment outbox publish failed for ${claimed.eventId}: ${error.message}`,
        );
      }
    }
    return published;
  }
}
