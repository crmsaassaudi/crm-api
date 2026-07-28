import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { ulid } from 'ulid';
import {
  AutomationOutboxEventDocument,
  AutomationOutboxEventSchemaClass,
} from '../infrastructure/persistence/document/entities/automation-outbox-event.schema';
import { AutomationEventPayload } from './automation-event.payload';
import { AutomationTriggerProducer } from '../queue/automation-trigger.producer';
import { MetricsService } from '../../observability/metrics.service';
import { isWorkerRuntime } from '../../config/runtime-role';
import { TransactionManager } from '../../database/transaction-manager.service';

const MAX_RETRIES = 20;
const CLAIM_TIMEOUT_MS = 2 * 60_000;
const BATCH_SIZE = 100;

/**
 * Durable bridge between committed CRM writes and BullMQ trigger evaluation.
 *
 * Capture always persists first. Queue publication is best-effort on the fast
 * path and retried by the worker poller, so a Redis outage no longer discards
 * the event. `eventId` also becomes the BullMQ job idempotency key.
 */
@Injectable()
export class AutomationOutboxService {
  private readonly logger = new Logger(AutomationOutboxService.name);

  constructor(
    @InjectModel(AutomationOutboxEventSchemaClass.name)
    private readonly outbox: Model<AutomationOutboxEventDocument>,
    private readonly triggerProducer: AutomationTriggerProducer,
    private readonly transactions: TransactionManager,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async capture(
    payload: AutomationEventPayload,
    session?: ClientSession,
  ): Promise<string> {
    const eventId = payload.eventId ?? ulid();
    const durablePayload = { ...payload, eventId };

    await this.outbox.create(
      [
        {
          tenantId: payload.tenantId,
          eventId,
          eventType: `${payload.event}.${payload.object}`,
          aggregateId: payload.recordId,
          payload: durablePayload,
          status: 'pending',
          retryCount: 0,
        },
      ],
      { session },
    );

    // Never publish an uncommitted row. The transactional caller publishes
    // after commit through runWithEvent(); the poller remains the safety net.
    if (!session) await this.publishAfterCommit(eventId);

    return eventId;
  }

  /**
   * Atomically commits a CRM aggregate mutation and its workflow event.
   * Redis publication happens only after Mongo commits and remains best-effort:
   * a queue outage leaves the durable row pending for the worker poller.
   */
  async runWithEvent<T>(
    mutate: (session: ClientSession) => Promise<T>,
    buildPayload: (result: T) => AutomationEventPayload | null,
  ): Promise<T> {
    const committed = await this.transactions.runInTransaction(
      async (session) => {
        const result = await mutate(session);
        const payload = buildPayload(result);
        const eventId = payload ? await this.capture(payload, session) : null;
        return { result, eventId };
      },
    );

    if (committed.eventId) {
      await this.publishAfterCommit(committed.eventId);
    }
    return committed.result;
  }

  async runWithEvents<T>(
    mutate: (
      session: ClientSession,
    ) => Promise<{ result: T; payloads: AutomationEventPayload[] }>,
  ): Promise<T> {
    const committed = await this.transactions.runInTransaction(
      async (session) => {
        const { result, payloads } = await mutate(session);
        const eventIds = await this.captureMany(payloads, session);
        return { result, eventIds };
      },
    );

    await Promise.all(
      committed.eventIds.map((eventId) => this.publishAfterCommit(eventId)),
    );
    return committed.result;
  }

  private async captureMany(
    payloads: AutomationEventPayload[],
    session: ClientSession,
  ): Promise<string[]> {
    if (payloads.length === 0) return [];
    const events = payloads.map((payload) => {
      const eventId = payload.eventId ?? ulid();
      return {
        tenantId: payload.tenantId,
        eventId,
        eventType: `${payload.event}.${payload.object}`,
        aggregateId: payload.recordId,
        payload: { ...payload, eventId },
        status: 'pending',
        retryCount: 0,
      };
    });
    await this.outbox.insertMany(events, { session, ordered: true });
    return events.map((event) => event.eventId);
  }

  private async publishAfterCommit(eventId: string): Promise<void> {
    await this.publishByEventId(eventId).catch((error: Error) => {
      this.logger.warn(
        `[AutomationOutbox] Fast publish deferred event=${eventId}: ${error.message}`,
      );
    });
  }

  @Cron('*/5 * * * * *')
  async publishPending(): Promise<number> {
    if (!isWorkerRuntime()) return 0;

    const candidates = await this.outbox
      .find({
        $or: [
          { status: 'pending' },
          {
            status: 'publishing',
            updatedAt: { $lt: new Date(Date.now() - CLAIM_TIMEOUT_MS) },
          },
        ],
        retryCount: { $lt: MAX_RETRIES },
      })
      .sort({ createdAt: 1 })
      .limit(BATCH_SIZE)
      .lean()
      .setOptions({ isPlatformQuery: true })
      .exec();

    let published = 0;
    for (const candidate of candidates) {
      try {
        if (await this.publishByEventId(candidate.eventId)) published++;
      } catch {
        // publishByEventId persists retry state and logs the actionable error.
      }
    }
    return published;
  }

  private async publishByEventId(eventId: string): Promise<boolean> {
    const staleBefore = new Date(Date.now() - CLAIM_TIMEOUT_MS);
    const claimed = await this.outbox
      .findOneAndUpdate(
        {
          eventId,
          $or: [
            { status: 'pending' },
            { status: 'publishing', updatedAt: { $lt: staleBefore } },
          ],
          retryCount: { $lt: MAX_RETRIES },
        },
        { $set: { status: 'publishing' } },
        { new: true },
      )
      .setOptions({ isPlatformQuery: true })
      .lean()
      .exec();

    if (!claimed) return false;

    try {
      await this.triggerProducer.enqueue(claimed.payload);
      await this.outbox
        .updateOne(
          { _id: claimed._id, status: 'publishing' },
          {
            $set: {
              status: 'published',
              publishedAt: new Date(),
              lastError: null,
            },
          },
        )
        .setOptions({ isPlatformQuery: true });
      this.metrics?.incrementCounter('crm_automation_outbox_published_total', {
        eventType: claimed.eventType,
      });
      return true;
    } catch (error: any) {
      const nextRetry = (claimed.retryCount ?? 0) + 1;
      const terminal = nextRetry >= MAX_RETRIES;
      await this.outbox
        .updateOne(
          { _id: claimed._id, status: 'publishing' },
          {
            $set: {
              status: terminal ? 'failed' : 'pending',
              lastError: error?.message ?? 'Unknown publish error',
            },
            $inc: { retryCount: 1 },
          },
        )
        .setOptions({ isPlatformQuery: true });
      this.metrics?.incrementCounter(
        'crm_automation_outbox_publish_failures_total',
        {
          eventType: claimed.eventType,
          terminal: String(terminal),
        },
      );
      this.logger.error(
        `[AutomationOutbox] Publish failed event=${eventId} ` +
          `attempt=${nextRetry}/${MAX_RETRIES}: ${error?.message}`,
      );
      throw error;
    }
  }
}
