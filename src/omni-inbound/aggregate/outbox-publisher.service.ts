import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';

import { RedisLockService } from '../../redis/redis-lock.service';
import { runAsClusterSingleton } from '../../common/scheduling/cluster-singleton';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import {
  OutboxEventSchemaClass,
  OutboxEventDocument,
} from '../infrastructure/persistence/document/entities/outbox-event.schema';

/** Max publish retries before marking an event as permanently failed. */
const MAX_OUTBOX_RETRIES = 10;

/** Events pending longer than this (ms) are considered stale and logged. */
const STALE_THRESHOLD_MS = 60_000;

/** How long a claimed event stays reserved before another run may retake it. */
const CLAIM_LEASE_MS = 60_000;

const BATCH_SIZE = 100;

/**
 * Publishes events the in-process publisher could not.
 *
 * ConversationOpsProcessor writes each event here before publishing it and
 * marks it published once the listeners finish. Anything still pending is an
 * event whose publish failed or whose process died holding it.
 *
 * Two things this has to get right, both of which it previously got wrong:
 *
 *  - **Tenant context.** Listeners write to tenant-filtered collections, and
 *    that plugin fails closed. Publishing without a tenant in CLS made every
 *    such listener throw, so the recovery path burned through its retries and
 *    marked the events failed — exactly the events that most needed replaying.
 *
 *  - **Exclusivity.** The scan is registered on both the worker and omni
 *    runtimes. Without a claim, two replicas pick up the same row and publish
 *    it twice, which for assignment and audit listeners is not harmless.
 */
@Injectable()
export class OutboxPublisherService {
  private readonly logger = new Logger(OutboxPublisherService.name);

  constructor(
    @InjectModel(OutboxEventSchemaClass.name)
    private readonly outboxModel: Model<OutboxEventDocument>,
    private readonly eventEmitter: EventEmitter2,
    private readonly lockService: RedisLockService,
    private readonly cls: ClsService,
  ) {}

  @Cron('*/5 * * * * *')
  async publishPendingEvents(): Promise<void> {
    await runAsClusterSingleton(
      { lockService: this.lockService, logger: this.logger },
      { name: 'omni:outbox-publisher', lockTtlMs: 30_000 },
      () => this.drainPending(),
    );
  }

  private async drainPending(): Promise<void> {
    const claimedBefore = new Date(Date.now() - CLAIM_LEASE_MS);

    const pending = await this.outboxModel
      .find({
        status: 'pending',
        $or: [{ claimedAt: null }, { claimedAt: { $lte: claimedBefore } }],
      })
      .sort({ createdAt: 1 })
      .limit(BATCH_SIZE)
      .exec();

    if (pending.length === 0) return;

    this.logger.debug(`[OUTBOX] Recovering ${pending.length} pending event(s)`);

    for (const entry of pending) {
      if (entry.retryCount >= MAX_OUTBOX_RETRIES) {
        await this.markPermanentlyFailed(entry);
        continue;
      }
      await this.publishClaimed(entry);
    }
  }

  private async markPermanentlyFailed(entry: OutboxEventDocument) {
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
      `[OUTBOX] PERMANENTLY FAILED: ${entry.eventType} id=${String(entry._id)} ` +
        `conv=${entry.conversationId} — moved to failed`,
    );
  }

  private async publishClaimed(entry: OutboxEventDocument): Promise<void> {
    // Claim first: whoever flips claimedAt owns this event for the lease.
    const claimed = await this.outboxModel.updateOne(
      { _id: entry._id, status: 'pending', claimedAt: entry.claimedAt ?? null },
      { $set: { claimedAt: new Date() } },
    );
    if (claimed.modifiedCount !== 1) return;

    const ageMs = Date.now() - new Date(entry.createdAt).getTime();
    if (ageMs > STALE_THRESHOLD_MS) {
      this.logger.warn(
        `[OUTBOX] STALE event: ${entry.eventType} id=${String(entry._id)} ` +
          `age=${Math.round(ageMs / 1000)}s retries=${entry.retryCount}`,
      );
    }

    try {
      await runWithTenantContext(this.cls, entry.tenantId, () =>
        this.eventEmitter.emitAsync(entry.eventType, entry.payload),
      );

      await this.outboxModel.updateOne(
        { _id: entry._id },
        { $set: { status: 'published', publishedAt: new Date() } },
      );
    } catch (err: any) {
      await this.outboxModel.updateOne(
        { _id: entry._id },
        {
          $inc: { retryCount: 1 },
          $set: { lastError: err?.message ?? 'Unknown error', claimedAt: null },
        },
      );
      this.logger.error(
        `[OUTBOX] Publish failed (retry ${entry.retryCount + 1}/${MAX_OUTBOX_RETRIES}): ` +
          `${entry.eventType} id=${String(entry._id)} error=${err?.message}`,
      );
    }
  }
}
