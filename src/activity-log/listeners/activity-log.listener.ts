import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BaseEvent } from '../../common/events/base.event';

@Injectable()
export class ActivityLogListener {
  private readonly logger = new Logger(ActivityLogListener.name);

  @OnEvent('**')
  handleAllEvents(event: BaseEvent) {
    // In a real application, you would save this to the database
    // validation to ensure it inherits from BaseEvent or specific event types
    if (event instanceof BaseEvent) {
      this.logger.log(
        `[ActivityLog] Event: ${event.constructor.name}, OccurredOn: ${event.occurredOn}, DispatcherId: ${event.dispatcherId}`,
      );
      // Example DB logic:
      // this.activityLogRepo.save({
      //   event: event.constructor.name,
      //   payload: JSON.stringify(event),
      //   userId: event.dispatcherId,
      //   timestamp: event.occurredOn
      // });
    }
  }
}
