import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Inject, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import type Redis from 'ioredis';
import { BaseConsumer } from '../../queue/base.consumer';
import { ConversationRepository } from '../repositories/conversation.repository';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { OMNI_AUTO_RESOLVE_QUEUE } from './omni-auto-resolve-queue.constants';

export interface AutoResolveJobData {
  tenantId: string;
  conversationId: string;
  /** 'warning' = send warning message first, 'resolve' = actually resolve */
  phase: 'warning' | 'resolve';
}

/**
 * BullMQ processor that handles per-conversation auto-resolve delayed jobs.
 *
 * Replaces the old cron-based DB scan approach. Each conversation gets its
 * own delayed job when created or when a new message arrives (timer reset).
 *
 * Two-phase flow (if autoWarningBeforeResolveHours is configured):
 *   Phase 1 (warning): Send "Are you still there?" message → schedule phase 2
 *   Phase 2 (resolve): Actually resolve the conversation
 *
 * Single-phase flow (if no warning configured):
 *   Directly resolve the conversation.
 */
@Processor(OMNI_AUTO_RESOLVE_QUEUE)
export class AutoResolveProcessor extends BaseConsumer {
  protected readonly logger = new Logger(AutoResolveProcessor.name);

  /** Redis key prefix for tracking whether warning has been sent */
  private readonly WARN_KEY_PREFIX = 'omni:auto-warn';

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly settingsService: CrmSettingsService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
  ) {
    super();
  }

  async process(job: Job<AutoResolveJobData>): Promise<void> {
    const { tenantId, conversationId, phase } = job.data;

    this.logger.debug(
      `Auto-resolve job [${phase}] for conversation ${conversationId}`,
    );

    // Verify conversation is still active
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      this.logger.debug(
        `Conversation ${conversationId} not found — skipping auto-resolve`,
      );
      return;
    }

    if (conversation.status !== 'open' && conversation.status !== 'pending') {
      this.logger.debug(
        `Conversation ${conversationId} is ${conversation.status} — skipping auto-resolve`,
      );
      return;
    }

    // Load tenant config
    const config = await this.getLifecycleConfig(tenantId);
    if (!config.autoResolveEnabled) {
      this.logger.debug(
        `Auto-resolve disabled for tenant ${tenantId} — skipping`,
      );
      return;
    }

    if (phase === 'warning') {
      await this.handleWarningPhase(
        tenantId,
        conversationId,
        conversation,
        config,
      );
    } else {
      await this.handleResolvePhase(
        tenantId,
        conversationId,
        conversation,
        config,
      );
    }
  }

  /**
   * Phase 1: Send a warning message before resolving.
   */
  private async handleWarningPhase(
    tenantId: string,
    conversationId: string,
    conversation: any,
    config: any,
  ): Promise<void> {
    const warningMessage =
      config.autoWarningMessage ??
      'Are you still there? This conversation will be closed soon if there is no response.';

    // Mark that warning has been sent
    const warnKey = `${this.WARN_KEY_PREFIX}:${conversationId}`;
    const warningHours = config.autoWarningBeforeResolveHours ?? 2;
    const warnTtlSeconds = warningHours * 60 * 60 + 3600; // warning period + 1h buffer
    await this.redis.set(warnKey, '1', 'EX', warnTtlSeconds);

    // Emit event for outbound service to send the warning message
    this.eventEmitter.emit('omni.auto_resolve.warning', {
      tenantId,
      conversationId,
      channelType: conversation.channelType,
      channelAccount: conversation.channelAccount,
      externalConversationId: conversation.externalConversationId,
      message: warningMessage,
    });

    this.logger.log(
      `Sent auto-resolve warning for conversation ${conversationId} ` +
        `— will resolve in ${warningHours}h if no reply`,
    );

    // Note: The resolve-phase job is scheduled by AutoResolveService.scheduleAutoResolve()
    // which is called again after the warning delay. The service manages the job lifecycle.
  }

  /**
   * Phase 2 (or single-phase): Actually resolve the conversation.
   */
  private async handleResolvePhase(
    tenantId: string,
    conversationId: string,
    conversation: any,
    config: any,
  ): Promise<void> {
    const timeoutHours = config.autoResolveTimeoutHours ?? 48;

    // Double-check inactivity — a message may have arrived after the job was scheduled
    const lastActivity = conversation.lastMessageAt ?? conversation.createdAt;
    const hoursSinceActivity =
      (Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60);

    // If warning is configured, use warningHours as the threshold for phase 2
    const warningHours = config.autoWarningBeforeResolveHours ?? 0;
    const effectiveThreshold = warningHours > 0 ? warningHours : timeoutHours;

    // Allow 5-minute tolerance for job scheduling jitter
    if (hoursSinceActivity < effectiveThreshold - 0.083) {
      this.logger.debug(
        `Conversation ${conversationId} had recent activity ` +
          `(${hoursSinceActivity.toFixed(1)}h ago) — skipping resolve`,
      );
      return;
    }

    await this.conversationRepo.updateStatusWithMetadata(
      conversationId,
      'resolved',
      null, // no agent (system action)
      'auto_resolved',
      `Auto-resolved after ${timeoutHours}h of inactivity`,
      'auto',
    );

    // Clean up warning key
    await this.redis.del(`${this.WARN_KEY_PREFIX}:${conversationId}`);

    // Emit event for cache invalidation + realtime broadcast
    this.eventEmitter.emit('omni.conversation.status_changed', {
      tenantId,
      conversationId,
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

    this.logger.log(
      `Auto-resolved conversation ${conversationId} ` +
        `(idle since ${lastActivity})`,
    );
  }

  private async getLifecycleConfig(tenantId: string): Promise<{
    autoResolveEnabled: boolean;
    autoResolveTimeoutHours: number;
    autoWarningBeforeResolveHours: number;
    autoWarningMessage: string;
  }> {
    const defaults = {
      autoResolveEnabled: true,
      autoResolveTimeoutHours: 48,
      autoWarningBeforeResolveHours: 0,
      autoWarningMessage:
        'Are you still there? This conversation will be closed soon if there is no response.',
    };

    try {
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
