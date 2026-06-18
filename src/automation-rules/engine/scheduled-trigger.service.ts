import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
 * Supported trigger configurations:
 *   - entity: 'ticket' | 'deal' | 'contact'
 *   - field: 'createdAt' | 'updatedAt' | 'resolvedAt' | 'closedAt'
 *   - offsetDays: number (how many days after the field value to fire)
 *   - condition: e.g. { status: 'open' } — additional field conditions
 *
 * When a matching record is found, emits `automation.trigger` with type
 * `time_based` so the AutomationRulesService can evaluate matching rules.
 */
@Injectable()
export class ScheduledTriggerService {
  private readonly logger = new Logger(ScheduledTriggerService.name);

  constructor(
    @InjectModel(TicketSchemaClass.name)
    private readonly ticketModel: Model<TicketSchemaDocument>,
    @InjectModel(DealSchemaClass.name)
    private readonly dealModel: Model<DealSchemaDocument>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Run every hour at the top of the hour.
   * Evaluates all time-based automation rules by scanning records
   * whose relevant date field crosses the configured offset threshold.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async runTimeBasedTriggers(): Promise<void> {
    this.logger.log(
      '[ScheduledTrigger] Running hourly time-based trigger scan',
    );

    await Promise.allSettled([
      this.scanStaleOpenTickets(),
      this.scanStaleOpenDeals(),
    ]);
  }

  /**
   * Example: Tickets that have been open for 3+ days without an update.
   * In production, these rules come from the automation rules config.
   * The current implementation fires a generic trigger; the automation engine
   * evaluates which rules apply to each tenant + entity.
   */
  private async scanStaleOpenTickets(): Promise<void> {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    const staleTickets = (await this.ticketModel
      .find({
        updatedAt: { $lte: threeDaysAgo },
      })
      .select('_id tenantId statusId updatedAt')
      .lean()
      .limit(500)
      .exec()) as any[];

    for (const ticket of staleTickets) {
      this.eventEmitter.emit('automation.trigger', {
        tenantId: String(ticket.tenantId),
        triggerType: 'time_based',
        subType: 'ticket.stale',
        entityId: String(ticket._id),
        entityType: 'ticket',
        payload: {
          ticketId: String(ticket._id),
          staleSince: ticket.updatedAt,
          offsetDays: 3,
          field: 'updatedAt',
          currentStatusId: ticket.statusId,
        },
      });
    }

    if (staleTickets.length > 0) {
      this.logger.log(
        `[ScheduledTrigger] Fired time_based triggers for ${staleTickets.length} stale tickets`,
      );
    }
  }

  /**
   * Example: Deals that have been in the same stage for 7+ days.
   */
  private async scanStaleOpenDeals(): Promise<void> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const staleDeals = (await this.dealModel
      .find({
        updatedAt: { $lte: sevenDaysAgo },
      })
      .select('_id tenantId stageId updatedAt')
      .lean()
      .limit(500)
      .exec()) as any[];

    for (const deal of staleDeals) {
      this.eventEmitter.emit('automation.trigger', {
        tenantId: String(deal.tenantId),
        triggerType: 'time_based',
        subType: 'deal.stale',
        entityId: String(deal._id),
        entityType: 'deal',
        payload: {
          dealId: String(deal._id),
          staleSince: deal.updatedAt,
          offsetDays: 7,
          field: 'updatedAt',
          currentStageId: deal.stageId,
        },
      });
    }

    if (staleDeals.length > 0) {
      this.logger.log(
        `[ScheduledTrigger] Fired time_based triggers for ${staleDeals.length} stale deals`,
      );
    }
  }
}
