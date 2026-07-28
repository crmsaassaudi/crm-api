import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class DataVisibilityCacheInvalidationListener {
  private readonly logger = new Logger(
    DataVisibilityCacheInvalidationListener.name,
  );

  constructor(private readonly redis: RedisService) {}

  @OnEvent('user.permissions.updated')
  @OnEvent('group.updated')
  @OnEvent('group.deleted')
  @OnEvent('group.membership.updated')
  @OnEvent('tenant.permissions.updated')
  @OnEvent('settings.changed')
  @OnEvent('channel-config.updated')
  @OnEvent('channel-config.deleted')
  async invalidate(event: { tenantId?: string }): Promise<void> {
    if (!event?.tenantId) return;
    try {
      await this.redis
        .getClient()
        .incr(`authz:scope:${event.tenantId}:version`);
    } catch (error) {
      // Cache reads also fail during a Redis outage and resolve live. A short
      // 60-second bundle TTL bounds recovery if this increment was missed.
      this.logger.error(
        `Visibility cache invalidation failed for ${event.tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
