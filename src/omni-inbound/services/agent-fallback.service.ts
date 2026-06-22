import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import type Redis from 'ioredis';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { OMNI_FALLBACK_QUEUE } from '../queue/omni-fallback-queue.constants';
import type { FallbackReassignJobData } from '../queue/fallback-reassign.processor';

/**
 * AgentFallbackService — handles agent disconnection gracefully.
 *
 * When an agent disconnects (network drop, tab close, etc.), this service:
 * 1. Records the disconnection timestamp in Redis
 * 2. Schedules a delayed BullMQ job (configurable via omni_auto_reassignment settings)
 * 3. If the agent is still offline after the delay:
 *    - The FallbackReassignProcessor finds all open conversations assigned to that agent
 *    - Reassigns them to available agents via AssignmentService
 *    - Emits events for realtime broadcast
 *
 * Architecture note (P0 fix):
 *   Previously used in-memory setTimeout() which could NOT survive server restarts.
 *   Now uses BullMQ delayed jobs persisted in Redis — survives restarts, rolling
 *   deployments, and process crashes.
 *
 * Configuration (from crm-settings key: omni_auto_reassignment):
 *   - enabled: boolean — turn off to disable auto-reassignment entirely
 *   - timeoutMinutes: number — delay before reassignment check (default: 3)
 *   - strategy: 'back-to-queue' | 'next-available' | 'supervisor'
 *   - notifyAgent: boolean — whether to notify the original agent
 */
@Injectable()
export class AgentFallbackService {
  private readonly logger = new Logger(AgentFallbackService.name);

  /** Redis key prefix for tracking disconnected agents */
  private readonly DISCONNECT_KEY_PREFIX = 'omni:agent:disconnected';

  constructor(
    private readonly settingsService: CrmSettingsService,
    @InjectQueue(OMNI_FALLBACK_QUEUE)
    private readonly fallbackQueue: Queue<FallbackReassignJobData>,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Called when an agent disconnects from the Socket.IO gateway.
   * Records the disconnect time and schedules a delayed BullMQ job.
   */
  async onAgentDisconnected(tenantId: string, agentId: string): Promise<void> {
    const config = await this.getReassignmentConfig(tenantId);

    if (!config.enabled) {
      this.logger.debug(
        `Auto-reassignment disabled for tenant ${tenantId} — skipping`,
      );
      return;
    }

    const redisKey = `${this.DISCONNECT_KEY_PREFIX}:${tenantId}:${agentId}`;
    const delayMs = (config.timeoutMinutes ?? 3) * 60 * 1000;
    const jobId = `fallback-${tenantId}-${agentId}`;

    // Record disconnect time in Redis (TTL = delay + 60s buffer)
    const ttlSeconds = Math.ceil(delayMs / 1000) + 60;
    await this.redis.set(redisKey, new Date().toISOString(), 'EX', ttlSeconds);

    this.logger.log(
      `Agent ${agentId} disconnected — scheduling reassignment check in ` +
        `${delayMs / 1000}s`,
    );

    // Remove any existing job for this agent (e.g. rapid disconnect/reconnect)
    try {
      const existingJob = await this.fallbackQueue.getJob(jobId);
      if (existingJob) {
        await existingJob.remove();
      }
    } catch {
      // Job may not exist — safe to ignore
    }

    // Schedule delayed reassignment via BullMQ (persisted in Redis)
    await this.fallbackQueue.add(
      'fallback-reassign',
      {
        tenantId,
        agentId,
        strategy: config.strategy,
        notifyAgent: config.notifyAgent,
      },
      {
        jobId,
        delay: delayMs,
      },
    );
  }

  /**
   * Called when an agent reconnects.
   * Cancels any pending reassignment job and clears the disconnect marker.
   */
  async onAgentReconnected(tenantId: string, agentId: string): Promise<void> {
    const redisKey = `${this.DISCONNECT_KEY_PREFIX}:${tenantId}:${agentId}`;
    const jobId = `fallback-${tenantId}-${agentId}`;

    // Cancel pending BullMQ job
    try {
      const existingJob = await this.fallbackQueue.getJob(jobId);
      if (existingJob) {
        await existingJob.remove();
        this.logger.log(
          `Agent ${agentId} reconnected — cancelled reassignment job`,
        );
      }
    } catch {
      // Job may not exist or already completed — safe to ignore
    }

    // Remove disconnect marker from Redis
    await this.redis.del(redisKey);
  }

  /**
   * Get auto-reassignment configuration from CRM settings.
   */
  private async getReassignmentConfig(tenantId: string): Promise<{
    enabled: boolean;
    timeoutMinutes: number;
    strategy: string;
    notifyAgent: boolean;
  }> {
    try {
      const config = await this.settingsService.getSetting(
        'omni_auto_reassignment',
        tenantId,
      );
      return {
        enabled: (config as any)?.enabled ?? true,
        timeoutMinutes: (config as any)?.timeoutMinutes ?? 3,
        strategy: (config as any)?.strategy ?? 'back-to-queue',
        notifyAgent: (config as any)?.notifyAgent ?? true,
      };
    } catch {
      return {
        enabled: true,
        timeoutMinutes: 3,
        strategy: 'back-to-queue',
        notifyAgent: true,
      };
    }
  }
}
