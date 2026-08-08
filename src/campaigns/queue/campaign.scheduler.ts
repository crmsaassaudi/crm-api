import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RedisLockService } from '../../redis/redis-lock.service';
import { CampaignDocument, CampaignSchemaClass } from '../campaign.schema';
import { CampaignProducer } from './campaign.producer';

/** Campaigns promoted per tick. A backlog drains over the following minutes. */
const SWEEP_LIMIT = 200;

/**
 * Starts campaigns whose scheduled time has arrived.
 *
 * A sweep rather than a delayed BullMQ job, because a campaign may be scheduled
 * weeks out: a delayed job holds that intent only in Redis, where an eviction or
 * a flush loses it silently. Here the intent lives in Mongo — the queue is only
 * ever asked to carry work that is due now.
 */
@Injectable()
export class CampaignScheduler {
  private readonly logger = new Logger(CampaignScheduler.name);
  private isSweeping = false;

  constructor(
    @InjectModel(CampaignSchemaClass.name)
    private readonly model: Model<CampaignDocument>,
    private readonly producer: CampaignProducer,
    private readonly lockService: RedisLockService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async promoteDueCampaigns(): Promise<void> {
    if (this.isSweeping) return;
    this.isSweeping = true;

    try {
      // `@Cron` fires in every process that loaded ScheduleModule, so without the
      // lock each replica would promote the same campaigns concurrently.
      await this.lockService.acquire(
        'cron:campaigns:promote-due',
        { ttl: 55_000, maxRetries: 0 },
        () => this.sweep(),
      );
    } catch (error: any) {
      if (error?.message?.includes('Could not acquire lock')) return;
      this.logger.error(
        `Failed to promote due campaigns: ${error.message}`,
        error.stack,
      );
    } finally {
      this.isSweeping = false;
    }
  }

  private async sweep(): Promise<void> {
    // The only cross-tenant read in the module, and it reads three fields. Every
    // decision that follows happens in a tenant-scoped worker; this loop just
    // answers "whose turn is it".
    const due = await this.model
      .find({
        status: 'scheduled',
        'schedule.sendAt': { $lte: new Date() },
        deletedAt: null,
      })
      .select('tenantId code +runScope')
      .sort({ 'schedule.sendAt': 1 })
      .limit(SWEEP_LIMIT)
      .setOptions({ isPlatformQuery: true } as any)
      .lean()
      .exec();

    for (const campaign of due) {
      // Claim by flipping the status first. If a second sweep — or an operator
      // pressing Launch — got there first, `modifiedCount` is 0 and this one
      // walks away rather than queueing the campaign twice.
      const claim = await this.model
        .updateOne(
          { _id: campaign._id, status: 'scheduled' },
          { $set: { status: 'sending' } },
        )
        .setOptions({ isPlatformQuery: true } as any)
        .exec();

      if (!claim.modifiedCount) continue;

      await this.producer.enqueueDispatch(
        String(campaign._id),
        String(campaign.tenantId),
        (campaign as any).runScope ?? undefined,
      );
      this.logger.log(`Campaign ${campaign.code} reached its send time.`);
    }
  }
}
