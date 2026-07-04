import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { OnEvent } from '@nestjs/event-emitter';
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
 * Setting ↔ Queue sync:
 *   When `omni_auto_reassignment` settings are changed via the UI, the controller
 *   emits a `settings.changed` event. This service listens and:
 *     - If `enabled` toggled OFF → cancels all pending jobs for that tenant
 *     - If `timeoutMinutes` changed → reschedules pending jobs with adjusted delay
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
    const disconnectTime = new Date().toISOString();

    // Record disconnect time in Redis (TTL = delay + 60s buffer)
    const ttlSeconds = Math.ceil(delayMs / 1000) + 60;
    await this.redis.set(redisKey, disconnectTime, 'EX', ttlSeconds);

    this.logger.log(
      `Agent ${agentId} disconnected — scheduling reassignment check in ` +
        `${delayMs / 1000}s`,
    );

    // Remove any existing job for this agent (e.g. rapid disconnect/reconnect)
    await this.removeJob(jobId);

    // Schedule delayed reassignment via BullMQ (persisted in Redis)
    await this.fallbackQueue.add(
      'fallback-reassign',
      {
        tenantId,
        agentId,
        strategy: config.strategy,
        notifyAgent: config.notifyAgent,
        disconnectTime,
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
    await this.removeJob(jobId);
    this.logger.log(
      `Agent ${agentId} reconnected — cancelled reassignment job`,
    );

    // Remove disconnect marker from Redis
    await this.redis.del(redisKey);
  }

  // ─── Setting ↔ Queue synchronization ─────────────────────────────────

  /**
   * Listens for `settings.changed` events emitted by CrmSettingsController.
   * When `omni_auto_reassignment` changes, synchronizes all pending BullMQ
   * jobs for that tenant:
   *   - enabled toggled OFF → cancel all pending jobs
   *   - timeoutMinutes changed → reschedule with adjusted delay
   */
  @OnEvent('settings.changed')
  async onSettingsChanged(payload: {
    key: string;
    tenantId: string;
  }): Promise<void> {
    if (payload.key !== 'omni_auto_reassignment') return;

    const { tenantId } = payload;
    this.logger.log(
      `Auto-reassignment settings changed for tenant ${tenantId} — syncing pending jobs`,
    );

    const config = await this.getReassignmentConfig(tenantId);

    // Scan for disconnected agents of this tenant
    const pattern = `${this.DISCONNECT_KEY_PREFIX}:${tenantId}:*`;
    const keys = await this.scanRedisKeys(pattern);

    if (keys.length === 0) {
      this.logger.debug(
        `No disconnected agents for tenant ${tenantId} — nothing to sync`,
      );
      return;
    }

    for (const key of keys) {
      const agentId = key.split(':').pop()!;
      const jobId = `fallback-${tenantId}-${agentId}`;

      if (!config.enabled) {
        // Feature disabled → cancel all pending jobs
        await this.removeJob(jobId);
        await this.redis.del(key);
        this.logger.log(
          `Cancelled reassignment for agent ${agentId} (feature disabled)`,
        );
      } else {
        // Feature still enabled — reschedule with potentially new timeout
        const disconnectTime = await this.redis.get(key);
        if (!disconnectTime) continue;

        const elapsed = Date.now() - new Date(disconnectTime).getTime();
        const newDelayMs = Math.max(
          0,
          config.timeoutMinutes * 60_000 - elapsed,
        );

        // Remove old job and schedule new one with adjusted delay
        await this.removeJob(jobId);

        // Refresh Redis TTL (new delay + 60s buffer)
        const ttlSeconds = Math.ceil(newDelayMs / 1000) + 60;
        await this.redis.set(key, disconnectTime, 'EX', ttlSeconds);

        await this.fallbackQueue.add(
          'fallback-reassign',
          {
            tenantId,
            agentId,
            strategy: config.strategy,
            notifyAgent: config.notifyAgent,
            disconnectTime,
          },
          { jobId, delay: newDelayMs },
        );

        this.logger.log(
          `Rescheduled reassignment for agent ${agentId}: ` +
            `new delay ${Math.round(newDelayMs / 1000)}s ` +
            `(elapsed ${Math.round(elapsed / 1000)}s, timeout ${config.timeoutMinutes}min)`,
        );
      }
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  /**
   * Safely remove a BullMQ job by ID.
   */
  private async removeJob(jobId: string): Promise<void> {
    try {
      const existingJob = await this.fallbackQueue.getJob(jobId);
      if (existingJob) {
        await existingJob.remove();
      }
    } catch {
      // Job may not exist or already completed — safe to ignore
    }
  }

  /**
   * Scan Redis keys matching a pattern using SCAN (non-blocking).
   * Avoids KEYS command which blocks Redis on large datasets.
   */
  private async scanRedisKeys(pattern: string): Promise<string[]> {
    const results: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      results.push(...keys);
    } while (cursor !== '0');
    return results;
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
      const cfg = config as Record<string, any>;
      return {
        enabled: cfg?.enabled ?? false,
        timeoutMinutes: cfg?.timeoutMinutes ?? 3,
        strategy: cfg?.strategy ?? 'back-to-queue',
        notifyAgent: cfg?.notifyAgent ?? true,
      };
    } catch {
      return {
        enabled: false,
        timeoutMinutes: 3,
        strategy: 'back-to-queue',
        notifyAgent: true,
      };
    }
  }
}
