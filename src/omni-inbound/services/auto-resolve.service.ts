import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConversationRepository } from '../repositories/conversation.repository';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';

/**
 * AutoResolveService — scheduled cron job that auto-resolves conversations
 * after a configurable period of inactivity.
 *
 * Configuration key: `omni_session_lifecycle.autoResolveTimeoutHours`
 *
 * Flow:
 *   1. Every 5 minutes, scan all tenants with active conversations
 *   2. For each tenant, load the lifecycle config
 *   3. Find conversations where lastMessageAt < (now - autoResolveTimeoutHours)
 *   4. Resolve each one with resolveSource: 'auto', resolveReason: 'auto_resolved'
 *   5. Emit status_changed event for cache invalidation + realtime broadcast
 */
@Injectable()
export class AutoResolveService {
  private readonly logger = new Logger(AutoResolveService.name);

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly settingsService: CrmSettingsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Run every 5 minutes — scan for idle conversations and auto-resolve them.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleAutoResolve(): Promise<void> {
    this.logger.debug('Auto-resolve cron started');

    try {
      // Get all distinct tenantIds that have open/pending conversations
      const tenantIds =
        await this.conversationRepo.findDistinctTenantIdsWithActiveConversations();

      if (tenantIds.length === 0) {
        this.logger.debug('No active conversations — skipping auto-resolve');
        return;
      }

      let totalResolved = 0;

      for (const tenantId of tenantIds) {
        try {
          const resolved = await this.autoResolveForTenant(tenantId);
          totalResolved += resolved;
        } catch (err) {
          this.logger.error(
            `Auto-resolve failed for tenant ${tenantId}: ${err.message}`,
          );
        }
      }

      if (totalResolved > 0) {
        this.logger.log(
          `Auto-resolve completed: ${totalResolved} conversations resolved across ${tenantIds.length} tenants`,
        );
      }
    } catch (err) {
      this.logger.error(`Auto-resolve cron failed: ${err.message}`, err.stack);
    }
  }

  /**
   * Auto-resolve idle conversations for a specific tenant.
   * Returns the number of conversations resolved.
   */
  private async autoResolveForTenant(tenantId: string): Promise<number> {
    // Load tenant lifecycle config
    const config = await this.getLifecycleConfig(tenantId);

    if (!config.autoResolveEnabled) {
      return 0;
    }

    const timeoutHours = config.autoResolveTimeoutHours ?? 48;
    const cutoffDate = new Date(Date.now() - timeoutHours * 60 * 60 * 1000);

    // Find conversations that are idle past the timeout
    const idleConversations = await this.conversationRepo.findIdleConversations(
      tenantId,
      cutoffDate,
    );

    if (idleConversations.length === 0) {
      return 0;
    }

    let resolvedCount = 0;

    for (const conversation of idleConversations) {
      try {
        await this.conversationRepo.updateStatusWithMetadata(
          conversation.id,
          'resolved',
          null, // no agent (system action)
          'auto_resolved',
          `Auto-resolved after ${timeoutHours}h of inactivity`,
          'auto',
        );

        // Emit event for cache invalidation + realtime broadcast
        this.eventEmitter.emit('omni.conversation.status_changed', {
          tenantId,
          conversationId: conversation.id,
          status: 'resolved',
          oldStatus: conversation.status,
          agentId: null,
          reason: 'auto_resolved',
          note: `Auto-resolved after ${timeoutHours}h of inactivity`,
          resolveSource: 'auto',
          channelType: conversation.channelType,
          channelAccount: conversation.channelAccount,
          externalConversationId: conversation.externalConversationId,
        });

        resolvedCount++;
        this.logger.debug(
          `Auto-resolved conversation ${conversation.id} (idle since ${conversation.lastMessageAt?.toISOString()})`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to auto-resolve conversation ${conversation.id}: ${err.message}`,
        );
      }
    }

    return resolvedCount;
  }

  /**
   * Load session lifecycle config for a tenant.
   */
  private async getLifecycleConfig(tenantId: string): Promise<{
    autoResolveEnabled: boolean;
    autoResolveTimeoutHours: number;
  }> {
    const defaults = {
      autoResolveEnabled: true,
      autoResolveTimeoutHours: 48,
    };

    try {
      // CrmSettingsService.getSetting uses the CLS-scoped tenantId,
      // but since we're in a cron job, we need to query by key with tenant prefix.
      // For now, use the generic getSetting (which works if the CLS context is set).
      // We fall back to defaults if no config is found.
      const config = await this.settingsService.getSetting(
        'omni_session_lifecycle',
        tenantId,
      );
      return config ? { ...defaults, ...config } : defaults;
    } catch {
      return defaults;
    }
  }
}
