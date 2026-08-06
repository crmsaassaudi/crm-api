import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import Redis from 'ioredis';
import {
  DealSchemaClass,
  DealSchemaDocument,
} from './infrastructure/persistence/document/entities/deal.schema';
import { IOREDIS_CLIENT } from '../redis/redis.tokens';
import { DEAL_FOLLOW_UP_CHANNEL } from './deals.constants';

/** How many notices one sweep dispatches. Keeps a backlog from monopolising a tick. */
const BATCH_SIZE = 500;

/**
 * How late a follow-up may be and still be announced.
 *
 * A notice about a call that was due last month is noise, not information. The
 * deal stays in the `followUp=overdue` list either way — this bound is only on
 * the push, so a worker that was down for a week wakes up and does not shout.
 */
const MAX_LATENESS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Announces follow-ups that have come due.
 *
 * The deal module had no notion of a next touch at all: there was no field, no
 * sweep and no notice, so "this lead has not been called in 24 hours" was a
 * question the system could not answer. For a B2C pipeline that is the question.
 *
 * Delivery uses the seam the platform already has — the `socket:*` Redis channel
 * `CrmRealtimeGateway` bridges into Socket.IO rooms. It is a live broadcast, not
 * a receipt: an offline owner sees the deal in their overdue queue on next login
 * rather than getting the notice later.
 */
@Injectable()
export class DealFollowUpService {
  private readonly logger = new Logger(DealFollowUpService.name);

  constructor(
    @InjectModel(DealSchemaClass.name)
    private readonly dealModel: Model<DealSchemaDocument>,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async dispatchDueFollowUps(): Promise<{ sent: number; skipped: number }> {
    const now = new Date();

    const due = await this.dealModel
      .find({
        nextFollowUpAt: { $ne: null, $lte: now },
        // The claim field doubles as the "already announced" marker.
        followUpNotifiedAt: null,
        wonAt: null,
        lostAt: null,
        deletedAt: null,
      })
      // Cross-tenant by design: follow-ups come due for every tenant at once, and
      // tenantFilterPlugin fails closed on a missing CLS tenant, which a cron has
      // no request to supply.
      .setOptions({ isPlatformQuery: true })
      .sort({ nextFollowUpAt: 1 })
      .limit(BATCH_SIZE)
      .select({
        _id: 1,
        tenantId: 1,
        ownerId: 1,
        title: 1,
        value: 1,
        currency: 1,
        stageId: 1,
        pipelineId: 1,
        nextFollowUpAt: 1,
      })
      .lean()
      .exec();

    if (due.length === 0) return { sent: 0, skipped: 0 };

    let sent = 0;
    let skipped = 0;

    for (const deal of due) {
      // Claim BEFORE delivering. `@Cron` fires in every process that loaded
      // ScheduleModule, so without a compare-and-set on `followUpNotifiedAt`
      // each replica would push its own copy. Claiming first means a lost race
      // sends nothing rather than everyone sending.
      if (!(await this.claim(String(deal._id)))) continue;

      const lateBy = now.getTime() - new Date(deal.nextFollowUpAt!).getTime();
      if (lateBy > MAX_LATENESS_MS) {
        skipped++;
        continue;
      }

      try {
        await this.redis.publish(
          DEAL_FOLLOW_UP_CHANNEL,
          JSON.stringify({
            tenantId: String(deal.tenantId),
            dealId: String(deal._id),
            ownerId: deal.ownerId ? String(deal.ownerId) : null,
            title: deal.title,
            value: deal.value,
            currency: deal.currency,
            pipelineId: String(deal.pipelineId),
            stageId: String(deal.stageId),
            dueAt: deal.nextFollowUpAt,
          }),
        );
        sent++;
      } catch (error) {
        // The claim stands. Saying so out loud is the point: leaving it unclaimed
        // would make the next sweep resend, and there is no delivery receipt to
        // deduplicate on.
        this.logger.error(
          `[DealFollowUp] Delivery failed for deal=${String(deal._id)}; ` +
            `it will NOT be retried: ${
              error instanceof Error ? error.message : String(error)
            }`,
        );
      }
    }

    if (sent > 0 || skipped > 0) {
      this.logger.log(
        `[DealFollowUp] ${sent} notice(s) dispatched, ${skipped} stale skipped`,
      );
    }
    return { sent, skipped };
  }

  private async claim(dealId: string): Promise<boolean> {
    const result = await this.dealModel
      .updateOne(
        { _id: dealId, followUpNotifiedAt: null },
        { $set: { followUpNotifiedAt: new Date() } },
      )
      .setOptions({ isPlatformQuery: true } as any)
      .exec();
    return result.modifiedCount > 0;
  }
}
