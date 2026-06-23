import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Inject, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Types } from 'mongoose';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import type Redis from 'ioredis';
import {
  BaseTenantConsumer,
  TenantJobData,
} from '../../queue/base-tenant.consumer';
import { AssignmentService } from '../services/assignment.service';
import { AgentPresenceService } from '../services/agent-presence.service';
import { ConversationRepository } from '../repositories/conversation.repository';
import { OMNI_FALLBACK_QUEUE } from './omni-fallback-queue.constants';

export interface FallbackReassignJobData extends TenantJobData {
  agentId: string;
  strategy: string;
  notifyAgent: boolean;
}

/**
 * BullMQ processor for agent-fallback reassignment.
 *
 * Replaces the previous in-memory setTimeout approach which could not
 * survive server restarts. Jobs are delayed (configurable, default 3min)
 * and persisted in Redis via BullMQ, so pending reassignments survive
 * process restarts and rolling deployments.
 *
 * Flow:
 *   1. Agent disconnects → AgentFallbackService adds a delayed job
 *   2. After delay, this processor checks if the agent is still offline
 *   3. If offline → reassigns all open conversations
 *   4. If reconnected → no-op (Redis disconnect marker already cleared)
 */
@Processor(OMNI_FALLBACK_QUEUE)
export class FallbackReassignProcessor extends BaseTenantConsumer<FallbackReassignJobData> {
  protected readonly logger = new Logger(FallbackReassignProcessor.name);
  protected readonly cls: ClsService;

  private readonly DISCONNECT_KEY_PREFIX = 'omni:agent:disconnected';

  constructor(
    private readonly assignmentService: AssignmentService,
    private readonly presenceService: AgentPresenceService,
    private readonly conversationRepo: ConversationRepository,
    private readonly eventEmitter: EventEmitter2,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    cls: ClsService,
  ) {
    super();
    this.cls = cls;
  }

  protected async handle(job: Job<FallbackReassignJobData>): Promise<void> {
    const { tenantId, agentId, strategy, notifyAgent: _notifyAgent } = job.data;

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
      `Agent ${agentId} still offline — reassigning open conversations (strategy: ${strategy})`,
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
    const assignmentStrategy = this.mapStrategy(strategy);

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

        // F-02 fix: release Redis capacity for the offline agent.
        // Previously this was never called, leaving the agent's activeConversations
        // counter inflated in Redis even after conversations were unassigned.
        // On reconnect the agent would be stuck in 'full' routing status
        // despite having 0 real conversations.
        await this.presenceService.releaseConversation(tenantId, agentId);

        // Emit event for realtime broadcast
        this.eventEmitter.emit('omni.conversation.assigned', {
          tenantId,
          conversationId: conversation.id,
          agentId: newAgentId,
          oldAgentId: agentId,
          reason: 'agent_offline_reassignment',
          strategy,
        });

        this.logger.log(
          `Reassigned conversation ${conversation.id}: ` +
            `${agentId} → ${newAgentId ?? 'queue (unassigned)'}`,
        );
      } catch (error: any) {
        this.logger.error(
          `Failed to reassign conversation ${conversation.id}: ${error.message}`,
        );
      }
    }


    // Cleanup disconnect marker
    await this.redis.del(redisKey);
  }

  private mapStrategy(configStrategy: string): string {
    switch (configStrategy) {
      case 'back-to-queue':
        return 'unassign';
      case 'next-available':
        return 'round-robin';
      case 'supervisor':
        return 'manual';
      default:
        return 'round-robin';
    }
  }
}
