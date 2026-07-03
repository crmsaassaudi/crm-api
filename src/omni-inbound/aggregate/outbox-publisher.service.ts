import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  OutboxEventSchemaClass,
  OutboxEventDocument,
} from '../infrastructure/persistence/document/entities/outbox-event.schema';

/** Max publish retries before marking event as permanently failed. */
const MAX_OUTBOX_RETRIES = 10;

/** Events pending longer than this (ms) are considered stale and logged. */
const STALE_THRESHOLD_MS = 60_000;

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
      // Detect stale events — may indicate a systemic publish failure
      const ageMs = Date.now() - new Date(entry.createdAt).getTime();
      if (ageMs > STALE_THRESHOLD_MS) {
        this.logger.warn(
          `[OUTBOX] STALE event detected: ${entry.eventType} ` +
            `id=${entry._id} age=${Math.round(ageMs / 1000)}s ` +
            `retries=${entry.retryCount} conv=${entry.conversationId}`,
        );
      }

      // Permanently failed — skip
      if (entry.retryCount >= MAX_OUTBOX_RETRIES) {
        await this.outboxModel.updateOne(
          { _id: entry._id },
          {
            $set: {
              status: 'failed',
              lastError: `Exceeded max retries (${MAX_OUTBOX_RETRIES})`,
            },
          },
        );
        this.logger.error(
          `[OUTBOX] PERMANENTLY FAILED: ${entry.eventType} ` +
            `id=${entry._id} conv=${entry.conversationId} — moved to failed`,
        );
        continue;
      }

      try {
        this.eventEmitter.emit(entry.eventType, entry.payload);

        await this.outboxModel.updateOne(
          { _id: entry._id },
          { $set: { status: 'published', publishedAt: new Date() } },
        );
      } catch (err: any) {
        await this.outboxModel.updateOne(
          { _id: entry._id },
          {
            $inc: { retryCount: 1 },
            $set: { lastError: err?.message ?? 'Unknown error' },
          },
        );
        this.logger.error(
          `[OUTBOX] Publish failed (retry ${entry.retryCount + 1}/${MAX_OUTBOX_RETRIES}): ` +
            `${entry.eventType} id=${entry._id} error=${err?.message}`,
        );
      }
    }
  }
}
