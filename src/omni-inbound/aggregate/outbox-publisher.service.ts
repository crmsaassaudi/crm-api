import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  OutboxEventSchemaClass,
  OutboxEventDocument,
} from '../infrastructure/persistence/document/entities/outbox-event.schema';

/**
 * OutboxPublisherService — cron-based poller that publishes events
 * from the transactional outbox collection.
 *
 * In the happy path, events are published in-process by the
 * ConversationOpsProcessor immediately after commit. This poller
 * serves as a safety net for events that were persisted to the
 * outbox but never published (e.g. process crash, OOM, timeout).
 *
 * Runs every 5 seconds. Processes up to 100 pending events per tick.
 */
@Injectable()
export class OutboxPublisherService {
  private readonly logger = new Logger(OutboxPublisherService.name);

  constructor(
    @InjectModel(OutboxEventSchemaClass.name)
    private readonly outboxModel: Model<OutboxEventDocument>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Cron('*/5 * * * * *')
  async publishPendingEvents(): Promise<void> {
    const pending = await this.outboxModel
      .find({ status: 'pending' })
      .sort({ createdAt: 1 })
      .limit(100)
      .exec();

    if (pending.length === 0) return;

    this.logger.debug(
      `[OUTBOX] Publishing ${pending.length} pending event(s)`,
    );

    for (const entry of pending) {
      try {
        this.eventEmitter.emit(entry.eventType, entry.payload);

        await this.outboxModel.updateOne(
          { _id: entry._id },
          { $set: { status: 'published', publishedAt: new Date() } },
        );
      } catch (err: any) {
        this.logger.error(
          `[OUTBOX] Failed to publish event ${entry._id} (${entry.eventType}): ${err?.message}`,
        );
        // Don't break the loop — try remaining events
      }
    }
  }
}
