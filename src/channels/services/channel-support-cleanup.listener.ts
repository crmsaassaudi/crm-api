import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ChannelSupportService } from './channel-support.service';

/**
 * Keeps channel support pools free of ids that no longer resolve.
 *
 * A deleted group or a user removed from the tenant stays in
 * `channel.support` unless something strips it out. The pool would still
 * *look* populated in the admin UI while resolving to fewer agents at routing
 * time — the kind of drift that surfaces as "conversations stopped being
 * assigned" with nothing in the config to explain it.
 *
 * Fire-and-forget: a failed cleanup must not fail the deletion that triggered
 * it. Worst case the stale id lingers and is skipped when the pool resolves.
 */
@Injectable()
export class ChannelSupportCleanupListener {
  private readonly logger = new Logger(ChannelSupportCleanupListener.name);

  constructor(private readonly supportService: ChannelSupportService) {}

  @OnEvent('group.deleted')
  async onGroupDeleted(payload: {
    tenantId: string;
    groupId: string;
  }): Promise<void> {
    await this.cleanup(payload?.tenantId, { groupId: payload?.groupId });
  }

  @OnEvent('user.removed-from-tenant')
  async onUserRemoved(payload: {
    tenantId: string;
    userId: string;
  }): Promise<void> {
    await this.cleanup(payload?.tenantId, { userId: payload?.userId });
  }

  private async cleanup(
    tenantId: string | undefined,
    ref: { userId?: string; groupId?: string },
  ): Promise<void> {
    if (!tenantId || (!ref.userId && !ref.groupId)) return;
    try {
      await this.supportService.removeMemberReferences(tenantId, ref);
    } catch (err: any) {
      this.logger.warn(
        `Channel support cleanup failed for tenant ${tenantId} ` +
          `(${JSON.stringify(ref)}): ${err.message}`,
      );
    }
  }
}
