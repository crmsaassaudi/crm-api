import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import {
  TicketSchemaClass,
  TicketSchemaDocument,
} from '../../tickets/infrastructure/persistence/document/entities/ticket.schema';
import {
  DealSchemaClass,
  DealSchemaDocument,
} from '../../deals/infrastructure/persistence/document/entities/deal.schema';

/**
 * ScheduledTriggerService — runs a cron job every hour to scan for CRM records
 * that match time-based automation conditions.
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

  constructor(
    @InjectModel(TicketSchemaClass.name)
    private readonly ticketModel: Model<TicketSchemaDocument>,
    @InjectModel(DealSchemaClass.name)
    private readonly dealModel: Model<DealSchemaDocument>,
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService,
  ) {}

  /**
   * Run every hour at the top of the hour.
   * Scans tickets and deals with status filters to only match active records.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async runTimeBasedTriggers(): Promise<void> {
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
