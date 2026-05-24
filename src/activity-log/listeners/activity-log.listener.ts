import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ActivityLogService } from '../activity-log.service';
import { ClsService } from 'nestjs-cls';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';

@Injectable()
export class ActivityLogListener {
  private readonly logger = new Logger(ActivityLogListener.name);

  constructor(
    private readonly activityLogService: ActivityLogService,
    private readonly cls: ClsService,
  ) {}

  @OnEvent('activity.create', { async: true })
  async handleActivityCreate(event: {
    tenantId?: string;
    targetType: string;
    targetId: string;
    event: string;
    actorId?: string;
    payload?: Record<string, any>;
    occurredAt?: Date;
  }): Promise<void> {
    try {
      const create = () =>
        this.activityLogService.create({
          targetType: event.targetType,
          targetId: event.targetId,
          event: event.event,
          actorId: event.actorId,
          payload: event.payload,
          occurredAt: event.occurredAt,
        });

      if (event.tenantId) {
        await runWithTenantContext(this.cls, event.tenantId, create);
        return;
      }

      await create();
    } catch (error) {
      this.logger.warn(
        `[ActivityLog] Failed to persist activity.create: ${(error as Error).message}`,
      );
    }
  }
}

