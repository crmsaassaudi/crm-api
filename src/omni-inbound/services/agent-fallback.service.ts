import { Injectable, Logger, Inject } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import type Redis from 'ioredis';
import { ConversationRepository } from '../repositories/conversation.repository';
import { AssignmentService } from './assignment.service';
import { AgentPresenceService } from './agent-presence.service';

/**
 * AgentFallbackService — handles agent disconnection gracefully.
 *
 * When an agent disconnects (network drop, tab close, etc.), this service:
 * 1. Records the disconnection timestamp in Redis
 * 2. Schedules a delayed check (default: 3 minutes)
 * 3. If the agent is still offline after the delay:
 *    - Finds all open conversations assigned to that agent
 *    - Reassigns them to available agents via AssignmentService
 *    - Emits events for realtime broadcast
 *
 * This prevents customer messages from falling into a "black hole"
 * when an agent goes offline unexpectedly.
 */
@Injectable()
export class AgentFallbackService {
  private readonly logger = new Logger(AgentFallbackService.name);

  /** How long to wait before reassigning (in ms). Default: 3 minutes. */
  private readonly REASSIGN_DELAY_MS = 3 * 60 * 1000;

  /** Redis key prefix for tracking disconnected agents */
  private readonly DISCONNECT_KEY_PREFIX = 'omni:agent:disconnected';

  /** In-memory map of pending reassignment timers, keyed by `tenantId:agentId` */
  private readonly pendingTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly assignmentService: AssignmentService,
    private readonly presenceService: AgentPresenceService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Called when an agent disconnects from the Socket.IO gateway.
   * Records the disconnect time and schedules a delayed reassignment check.
   */
  async onAgentDisconnected(tenantId: string, agentId: string): Promise<void> {
    const timerKey = `${tenantId}:${agentId}`;
    const redisKey = `${this.DISCONNECT_KEY_PREFIX}:${tenantId}:${agentId}`;

    // Record disconnect time in Redis (TTL = REASSIGN_DELAY + 60s buffer)
    const ttlSeconds = Math.ceil(this.REASSIGN_DELAY_MS / 1000) + 60;
    await this.redis.set(redisKey, new Date().toISOString(), 'EX', ttlSeconds);

    this.logger.log(
      `Agent ${agentId} disconnected — scheduling reassignment check in ` +
        `${this.REASSIGN_DELAY_MS / 1000}s`,
    );

    // Cancel any existing timer for this agent (e.g. rapid disconnect/reconnect)
    const existingTimer = this.pendingTimers.get(timerKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule delayed reassignment check
    const timer = setTimeout(async () => {
      this.pendingTimers.delete(timerKey);
      await this.executeReassignmentCheck(tenantId, agentId);
    }, this.REASSIGN_DELAY_MS);

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
  ): Promise<void> {
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
      `Agent ${agentId} still offline after ${this.REASSIGN_DELAY_MS / 1000}s ` +
        `— reassigning open conversations`,
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

    for (const conversation of openConversations) {
      try {
        const newAgentId = await this.assignmentService.assignConversation(
          tenantId,
          conversation.id,
          'round-robin',
        );

        // Emit event for realtime broadcast
        this.eventEmitter.emit('omni.conversation.assigned', {
          tenantId,
          conversationId: conversation.id,
          agentId: newAgentId,
          oldAgentId: agentId,
          reason: 'agent_offline_reassignment',
        });

        this.logger.log(
          `Reassigned conversation ${conversation.id}: ` +
            `${agentId} → ${newAgentId ?? 'unassigned (no agents available)'}`,
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
}
