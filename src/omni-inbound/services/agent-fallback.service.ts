import { Injectable, Logger, Inject } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Types } from 'mongoose';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import type Redis from 'ioredis';
import { ConversationRepository } from '../repositories/conversation.repository';
import { AssignmentService } from './assignment.service';
import { AgentPresenceService } from './agent-presence.service';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';

/**
 * AgentFallbackService — handles agent disconnection gracefully.
 *
 * When an agent disconnects (network drop, tab close, etc.), this service:
 * 1. Records the disconnection timestamp in Redis
 * 2. Schedules a delayed check (configurable via omni_auto_reassignment settings)
 * 3. If the agent is still offline after the delay:
 *    - Finds all open conversations assigned to that agent
 *    - Reassigns them to available agents via AssignmentService
 *    - Emits events for realtime broadcast
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

  /** In-memory map of pending reassignment timers, keyed by `tenantId:agentId` */
  private readonly pendingTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly assignmentService: AssignmentService,
    private readonly presenceService: AgentPresenceService,
    private readonly settingsService: CrmSettingsService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Called when an agent disconnects from the Socket.IO gateway.
   * Records the disconnect time and schedules a delayed reassignment check.
   */
  async onAgentDisconnected(tenantId: string, agentId: string): Promise<void> {
    const config = await this.getReassignmentConfig(tenantId);

    if (!config.enabled) {
      this.logger.debug(
        `Auto-reassignment disabled for tenant ${tenantId} — skipping`,
      );
      return;
    }

    const timerKey = `${tenantId}:${agentId}`;
    const redisKey = `${this.DISCONNECT_KEY_PREFIX}:${tenantId}:${agentId}`;
    const delayMs = (config.timeoutMinutes ?? 3) * 60 * 1000;

    // Record disconnect time in Redis (TTL = delay + 60s buffer)
    const ttlSeconds = Math.ceil(delayMs / 1000) + 60;
    await this.redis.set(redisKey, new Date().toISOString(), 'EX', ttlSeconds);

    this.logger.log(
      `Agent ${agentId} disconnected — scheduling reassignment check in ` +
        `${delayMs / 1000}s`,
    );

    // Cancel any existing timer for this agent (e.g. rapid disconnect/reconnect)
    const existingTimer = this.pendingTimers.get(timerKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule delayed reassignment check
    const timer = setTimeout(async () => {
      this.pendingTimers.delete(timerKey);
      await this.executeReassignmentCheck(tenantId, agentId, config);
    }, delayMs);

    this.pendingTimers.set(timerKey, timer);
  }

  /**
   * Called when an agent reconnects.
   * Cancels any pending reassignment timer and clears the disconnect marker.
   */
  async onAgentReconnected(tenantId: string, agentId: string): Promise<void> {
    const timerKey = `${tenantId}:${agentId}`;
    const redisKey = `${this.DISCONNECT_KEY_PREFIX}:${tenantId}:${agentId}`;

    // Cancel pending timer
    const existingTimer = this.pendingTimers.get(timerKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.pendingTimers.delete(timerKey);
      this.logger.log(
        `Agent ${agentId} reconnected — cancelled reassignment timer`,
      );
    }

    // Remove disconnect marker from Redis
    await this.redis.del(redisKey);
  }

  /**
   * Executes the actual reassignment check after the delay period.
   * Only reassigns if the agent is still offline (presence key expired or
   * disconnect marker still exists in Redis).
   */
  private async executeReassignmentCheck(
    tenantId: string,
    agentId: string,
    config: { strategy: string; notifyAgent: boolean },
  ): Promise<void> {
    // Guard: agentId must be a valid ObjectId to query assignedAgentId
    if (!Types.ObjectId.isValid(agentId)) {
      this.logger.warn(
        `Agent ${agentId} is not a valid ObjectId — skipping reassignment`,
      );
      return;
    }

    const redisKey = `${this.DISCONNECT_KEY_PREFIX}:${tenantId}:${agentId}`;

    // Check if the agent has reconnected in the meantime
    const stillDisconnected = await this.redis.get(redisKey);
    if (!stillDisconnected) {
      this.logger.debug(
        `Agent ${agentId} reconnected before reassignment — skipping`,
      );
      return;
    }

    // Double-check via presence service
    const presence = await this.presenceService.getPresence(tenantId, agentId);
    if (presence) {
      this.logger.debug(
        `Agent ${agentId} has active presence — skipping reassignment`,
      );
      await this.redis.del(redisKey);
      return;
    }

    // Agent is confirmed offline — find their open conversations
    this.logger.warn(
      `Agent ${agentId} still offline — reassigning open conversations (strategy: ${config.strategy})`,
    );

    const openConversations = await this.conversationRepo.findOpenByAgent(
      tenantId,
      agentId,
    );

    if (openConversations.length === 0) {
      this.logger.log(`No open conversations to reassign for agent ${agentId}`);
      await this.redis.del(redisKey);
      return;
    }

    this.logger.log(
      `Reassigning ${openConversations.length} conversation(s) from offline agent ${agentId}`,
    );

    // Map config strategy to assignment strategy
    const assignmentStrategy = this.mapStrategy(config.strategy);

    for (const conversation of openConversations) {
      try {
        let newAgentId: string | null = null;

        if (assignmentStrategy === 'unassign') {
          // 'back-to-queue' — just unassign, conversation goes back to queue
          await this.conversationRepo.updateAssignment(
            conversation.id,
            null as any,
          );
        } else {
          newAgentId = await this.assignmentService.assignConversation(
            tenantId,
            conversation.id,
            {
              strategy: assignmentStrategy as any,
              allowReassignment: true,
            },
          );
        }

        // Emit event for realtime broadcast
        this.eventEmitter.emit('omni.conversation.assigned', {
          tenantId,
          conversationId: conversation.id,
          agentId: newAgentId,
          oldAgentId: agentId,
          reason: 'agent_offline_reassignment',
          strategy: config.strategy,
        });

        this.logger.log(
          `Reassigned conversation ${conversation.id}: ` +
            `${agentId} → ${newAgentId ?? 'queue (unassigned)'}`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to reassign conversation ${conversation.id}: ${error.message}`,
        );
      }
    }

    // Cleanup disconnect marker
    await this.redis.del(redisKey);
  }

  /**
   * Map the config strategy name to an internal assignment strategy.
   */
  private mapStrategy(configStrategy: string): string {
    switch (configStrategy) {
      case 'back-to-queue':
        return 'unassign';
      case 'next-available':
        return 'round-robin';
      case 'supervisor':
        return 'manual'; // supervisor-based → goes to manual queue for supervisor pickup
      default:
        return 'round-robin';
    }
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
