import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BaseEvent } from '../../common/events/base.event';
import { ActivityLogService } from '../activity-log.service';

@Injectable()
export class ActivityLogListener {
  private readonly logger = new Logger(ActivityLogListener.name);

  constructor(private readonly activityLogService: ActivityLogService) {}

  @OnEvent('**', { async: true })
  async handleAllEvents(event: BaseEvent | any): Promise<void> {
    try {
      if (event instanceof BaseEvent) {
        await this.activityLogService.create({
          targetType: 'system',
          targetId: event.dispatcherId || 'unknown',
          event: event.constructor.name,
          actorId: event.dispatcherId,
          payload: { event },
          occurredAt: event.occurredOn,
        });
        return;
      }

      if (event?.tenantId && event?.object && event?.recordId && event?.event) {
        await this.activityLogService.create({
          targetType: String(event.object).toLowerCase(),
          targetId: event.recordId,
          event: event.event,
          payload: event,
        });
      }
    } catch (error) {
      this.logger.warn(
        `[ActivityLog] Failed to persist event: ${(error as Error).message}`,
      );
    }
  }
}
