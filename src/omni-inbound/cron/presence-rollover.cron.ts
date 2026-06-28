import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisLockService } from '../../redis/redis-lock.service';
import { AgentPresenceService } from '../services/agent-presence.service';
import { PresenceSegmentService } from '../services/presence-segment.service';

/**
 * Midnight rollover (docs/agent-presence-workforce-spec.md §3.2).
 *
 * At UTC midnight, for every agent still online across the day boundary:
 *   1. Cut all open reporting segments at 00:00 and re-open them (same value),
 *      so no segment spans two days and each day's totals are self-contained
 *      (reporting invariant §4.1).
 *   2. Reset routing → NOT_ACCEPTING — a new day never carries ACCEPTING; the
 *      agent must re-arm Ready (TC04).
 *
 * NOTE: this runs at a single UTC midnight for all tenants. Per-tenant timezone
 * boundaries are a Phase 5 refinement (wire to general_localization).
 */
@Injectable()
export class PresenceRolloverCron {
  private readonly logger = new Logger(PresenceRolloverCron.name);

  private static readonly CONCURRENCY = 10;

  constructor(
    private readonly lockService: RedisLockService,
    private readonly presenceService: AgentPresenceService,
    private readonly segmentService: PresenceSegmentService,
  ) {}

  @Cron('0 0 * * *', { name: 'presence-rollover', timeZone: 'UTC' })
  async handleRollover(): Promise<void> {
    try {
      await this.lockService.acquire(
        'cron:presence:rollover',
        10 * 60 * 1000, // 10 min TTL
        () => this.run(),
        0,
        1, // fail fast if another instance holds the lock
      );
    } catch (err: any) {
      this.logger.warn(`Presence rollover skipped: ${err.message}`);
    }
  }

  private async run(): Promise<void> {
    // Boundary = the UTC midnight that just started (today 00:00:00.000Z).
    const now = new Date();
    const boundaryMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0,
    );

    const tenants = await this.presenceService.getActivePresenceTenants();
    this.logger.log(
      `Presence rollover starting for ${tenants.length} active tenant(s) at ${new Date(boundaryMs).toISOString()}`,
    );

    let agentCount = 0;
    for (const tenantId of tenants) {
      const agents = await this.presenceService.getAllAgents(tenantId);
      for (let i = 0; i < agents.length; i += PresenceRolloverCron.CONCURRENCY) {
        const batch = agents.slice(i, i + PresenceRolloverCron.CONCURRENCY);
        await Promise.allSettled(
          batch.map(async (a) => {
            // 1. Cut + re-open segments at the boundary.
            await this.segmentService.rolloverAgent(tenantId, a.userId, boundaryMs);
            // 2. Reset routing for the new day (fires its own segment change).
            await this.presenceService.applyDayRollover(tenantId, a.userId);
          }),
        );
        agentCount += batch.length;
      }
    }

    this.logger.log(`Presence rollover done — ${agentCount} agent(s) processed`);
  }
}
