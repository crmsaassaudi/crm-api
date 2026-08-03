import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import { RedisLockService } from '../../redis/redis-lock.service';
import {
  TicketSchemaClass,
  TicketSchemaDocument,
} from '../../tickets/infrastructure/persistence/document/entities/ticket.schema';
import {
  DealSchemaClass,
  DealSchemaDocument,
} from '../../deals/infrastructure/persistence/document/entities/deal.schema';

/**
 * ScheduledTriggerService — hourly scan for CRM records that match time-based
 * automation conditions.
 *
 * NOT WIRED TO THE ENGINE
 * The scan emits `automation.trigger`, which nothing consumes. The engine only
 * matches workflows on `publishedTriggerConfig.event`, whose only values are
 * `record_created` and `field_updated` (TriggerConfigDto), so a "ticket has been
 * open for 3 days" workflow cannot even be authored today. Previously the
 * emitted event was picked up by an `automation.**` wildcard listener whose
 * handler expected a different payload shape, which made EVERY active workflow
 * of every tenant match and execute hourly against an empty record — DLQ flood
 * and bogus execution history, not working time-based automation.
 *
 * The scan is therefore disabled rather than left to burn a full-collection read
 * per replica per hour for no effect. The query logic is kept because it is the
 * right query: enabling this needs a `time_based` trigger type end to end
 * (DTO enum → publishedTriggerConfig matching → AutomationEventPayload), and
 * `ENABLE_TIME_BASED_TRIGGERS=true` flips it on once that exists.
 *
 * Also note when enabling: BATCH_LIMIT is a GLOBAL cap across all tenants, so
 * at any real tenant count most tenants would never be scanned. It needs to
 * become a per-tenant sharded scan first.
 *
 * Queries include explicit status filters to avoid triggering on resolved/closed
 * records. Results are iterated via cursor to handle large result sets without
 * loading everything into memory.
 *
 * Each emitted event carries the record's own tenantId, so the automation
 * engine's tenant-scoped workflow lookup ensures correct isolation.
 */
@Injectable()
export class ScheduledTriggerService {
  private readonly logger = new Logger(ScheduledTriggerService.name);

  /** Max records per entity type per cron tick to prevent CPU starvation. */
  private readonly BATCH_LIMIT = 1000;

  /** Cluster-wide singleton lock — see runTimeBasedTriggers. */
  private static readonly LOCK_KEY = 'cron:automation:time-based-triggers';
  private static readonly LOCK_TTL_MS = 10 * 60 * 1000;

  constructor(
    @InjectModel(TicketSchemaClass.name)
    private readonly ticketModel: Model<TicketSchemaDocument>,
    @InjectModel(DealSchemaClass.name)
    private readonly dealModel: Model<DealSchemaDocument>,
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService,
    private readonly lockService: RedisLockService,
  ) {}

  private get enabled(): boolean {
    return process.env.ENABLE_TIME_BASED_TRIGGERS === 'true';
  }

  /**
   * Run every hour at the top of the hour.
   * Scans tickets and deals with status filters to only match active records.
   *
   * Cluster-singleton: `@Cron` fires in every process that loaded
   * ScheduleModule, so without the lock this scan runs once per API replica plus
   * once per worker replica, multiplying every emitted trigger by the replica
   * count.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async runTimeBasedTriggers(): Promise<void> {
    if (!this.enabled) {
      this.logger.debug(
        '[ScheduledTrigger] Skipped — time-based triggers are not wired to the ' +
          'automation engine (set ENABLE_TIME_BASED_TRIGGERS=true only once a ' +
          'time_based trigger type exists end to end).',
      );
      return;
    }

    await this.lockService
      .acquire(
        ScheduledTriggerService.LOCK_KEY,
        { ttl: ScheduledTriggerService.LOCK_TTL_MS, maxRetries: 0 },
        () => this.scanAll(),
      )
      .catch((err) =>
        // Another replica holds the lock, or lost it mid-scan. Either way this
        // tick is someone else's; the next hour will try again.
        this.logger.debug(
          `[ScheduledTrigger] Skipping tick: ${(err as Error).message}`,
        ),
      );
  }

  private async scanAll(): Promise<void> {
    this.logger.log(
      '[ScheduledTrigger] Running hourly time-based trigger scan',
    );

    const results = await Promise.allSettled([
      this.scanStaleOpenTickets(),
      this.scanStaleOpenDeals(),
    ]);

    // allSettled swallows failures — surface them or a broken scan stays silent.
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error(
          `[ScheduledTrigger] Scan failed: ${
            (result.reason as Error)?.message ?? String(result.reason)
          }`,
          (result.reason as Error)?.stack,
        );
      }
    }
  }

  /**
   * Tickets that have been open (not resolved/closed) for 3+ days without
   * an update. Excludes resolved/closed tickets via timestamp filters.
   *
   * Each emitted event carries the record's tenantId — the automation engine
   * only matches workflows belonging to that specific tenant.
   */
  private async scanStaleOpenTickets(): Promise<void> {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    let emitted = 0;
    const cursor = this.ticketModel
      .find({
        updatedAt: { $lte: threeDaysAgo },
        // Exclude resolved/closed — only trigger on active tickets
        resolvedAt: { $exists: false },
        closedAt: { $exists: false },
      })
      .select('_id tenantId statusId updatedAt')
      // Platform-level scan: stale tickets of every tenant are due here. Each
      // emitted event carries its own tenantId for downstream scoping.
      .setOptions({ isPlatformQuery: true })
      .lean()
      .limit(this.BATCH_LIMIT)
      .cursor();

    for await (const ticket of cursor) {
      const tenantId = ticket.tenantId ? String(ticket.tenantId) : '';
      if (!tenantId) {
        this.logger.error(
          `[ScheduledTrigger] Skipping ticket ${String(ticket._id)}: missing tenantId`,
        );
        continue;
      }

      // Listeners run synchronously on this call stack and query tenant-scoped
      // collections, so the emit must carry CLS tenant context.
      runWithTenantContext(this.cls, tenantId, () =>
        this.eventEmitter.emit('automation.trigger', {
          tenantId,
          triggerType: 'time_based',
          subType: 'ticket.stale',
          entityId: String(ticket._id),
          entityType: 'ticket',
          payload: {
            ticketId: String(ticket._id),
            staleSince: ticket.updatedAt,
            offsetDays: 3,
            field: 'updatedAt',
            currentStatusId: (ticket as any).statusId,
          },
        }),
      );
      emitted++;
    }

    if (emitted > 0) {
      this.logger.log(
        `[ScheduledTrigger] Fired time_based triggers for ${emitted} stale tickets`,
      );
    }
  }

  /**
   * Deals that have been in the same stage for 7+ days.
   * Excludes won/lost deals via timestamp filters.
   */
  private async scanStaleOpenDeals(): Promise<void> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    let emitted = 0;
    const cursor = this.dealModel
      .find({
        updatedAt: { $lte: sevenDaysAgo },
        // Exclude won/lost deals
        wonAt: { $exists: false },
        lostAt: { $exists: false },
      })
      .select('_id tenantId stageId updatedAt')
      // Platform-level scan: stale deals of every tenant are due here.
      .setOptions({ isPlatformQuery: true })
      .lean()
      .limit(this.BATCH_LIMIT)
      .cursor();

    for await (const deal of cursor) {
      const tenantId = deal.tenantId ? String(deal.tenantId) : '';
      if (!tenantId) {
        this.logger.error(
          `[ScheduledTrigger] Skipping deal ${String(deal._id)}: missing tenantId`,
        );
        continue;
      }

      runWithTenantContext(this.cls, tenantId, () =>
        this.eventEmitter.emit('automation.trigger', {
          tenantId,
          triggerType: 'time_based',
          subType: 'deal.stale',
          entityId: String(deal._id),
          entityType: 'deal',
          payload: {
            dealId: String(deal._id),
            staleSince: deal.updatedAt,
            offsetDays: 7,
            field: 'updatedAt',
            currentStageId: (deal as any).stageId,
          },
        }),
      );
      emitted++;
    }

    if (emitted > 0) {
      this.logger.log(
        `[ScheduledTrigger] Fired time_based triggers for ${emitted} stale deals`,
      );
    }
  }
}
