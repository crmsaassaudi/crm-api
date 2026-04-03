import { Injectable, Logger, Inject } from '@nestjs/common';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import type Redis from 'ioredis';
import { ConversationRepository } from '../repositories/conversation.repository';
import { AgentPresenceService } from './agent-presence.service';
import {
  AssignmentAuditLogRepository,
  CreateAuditLogDto,
} from '../repositories/assignment-audit-log.repository';

export type AssignmentStrategy =
  | 'round-robin'
  | 'least-busy'
  | 'capacity-based'
  | 'manual';

/** Default max concurrent open chats per agent */
const DEFAULT_MAX_CAPACITY = 5;

/**
 * AssignmentService — auto-assigns conversations to agents based on
 * configurable strategies. Called when a new conversation is created.
 *
 * Strategies:
 *   - round-robin: cycles through available agents using a Redis counter
 *   - least-busy: picks the agent with fewest open conversations
 *   - capacity-based: like least-busy but caps each agent to a max capacity
 *   - manual: no auto-assign — goes to queue for manual pickup
 *
 * Every assignment decision is recorded in the AssignmentAuditLog.
 */
@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly presenceService: AgentPresenceService,
    private readonly auditLogRepo: AssignmentAuditLogRepository,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Auto-assign a conversation to an available agent.
   * Returns the assigned agent ID, or null if no agent is available.
   */
  async assignConversation(
    tenantId: string,
    conversationId: string,
    strategy: AssignmentStrategy = 'round-robin',
    agentPool?: string[],
    maxCapacity: number = DEFAULT_MAX_CAPACITY,
  ): Promise<string | null> {
    // Get available agents (online/available status)
    const availableAgents = await this.getAvailableAgents(tenantId, agentPool);

    if (availableAgents.length === 0) {
      this.logger.warn(
        `No available agents for tenant ${tenantId} — conversation ${conversationId} goes to queue`,
      );
      await this.writeAuditLog({
        tenantId,
        conversationId,
        assignedAgentId: null,
        strategy,
        reason: 'No available agents online — conversation queued',
        metadata: { poolSize: agentPool?.length ?? 0 },
        outcome: 'queued',
      });
      return null;
    }

    let selectedAgent: string | null = null;
    let reason = '';
    let metadata: Record<string, any> = {};

    switch (strategy) {
      case 'round-robin': {
        selectedAgent = await this.roundRobin(tenantId, availableAgents);
        reason = `Round-robin selected agent (index from Redis counter)`;
        metadata = { pool: availableAgents };
        break;
      }
      case 'least-busy': {
        const result = await this.leastBusy(tenantId, availableAgents);
        selectedAgent = result.agentId;
        reason = `Least-busy: agent has ${result.openChats} open chats (fewest in pool)`;
        metadata = { pool: availableAgents, openChats: result.openChats };
        break;
      }
      case 'capacity-based': {
        const result = await this.capacityBased(
          tenantId,
          availableAgents,
          maxCapacity,
        );
        selectedAgent = result.agentId;
        if (selectedAgent) {
          reason = `Capacity-based: agent has ${result.openChats}/${maxCapacity} open chats`;
        } else {
          reason = `All agents at max capacity (${maxCapacity}) — conversation queued`;
        }
        metadata = {
          pool: availableAgents,
          maxCapacity,
          openChats: result.openChats,
          allLoads: result.allLoads,
        };
        break;
      }
      case 'manual':
      default: {
        reason = 'Manual assignment — no auto-assign';
        await this.writeAuditLog({
          tenantId,
          conversationId,
          assignedAgentId: null,
          strategy: 'manual',
          reason,
          metadata: {},
          outcome: 'queued',
        });
        return null;
      }
    }

    if (selectedAgent) {
      await this.conversationRepo.updateAssignment(
        conversationId,
        selectedAgent,
      );
      this.logger.log(
        `Auto-assigned conversation ${conversationId} to agent ${selectedAgent} (${strategy})`,
      );
      await this.writeAuditLog({
        tenantId,
        conversationId,
        assignedAgentId: selectedAgent,
        strategy,
        reason,
        metadata,
        outcome: 'assigned',
      });
    } else {
      this.logger.warn(
        `No agent available under ${strategy} for conversation ${conversationId} — queued`,
      );
      await this.writeAuditLog({
        tenantId,
        conversationId,
        assignedAgentId: null,
        strategy,
        reason,
        metadata,
        outcome: 'queued',
      });
    }

    return selectedAgent;
  }

  /**
   * Round-robin: use a Redis counter to cycle through the agent pool.
   */
  private async roundRobin(
    tenantId: string,
    agents: string[],
  ): Promise<string> {
    const key = `omni:rr:${tenantId}`;
    const counter = await this.redis.incr(key);
    // Set TTL on first creation (24h)
    if (counter === 1) {
      await this.redis.expire(key, 86400);
    }
    const index = (counter - 1) % agents.length;
    return agents[index];
  }

  /**
   * Least-busy: pick the agent with the fewest open/pending conversations.
   */
  private async leastBusy(
    tenantId: string,
    agents: string[],
  ): Promise<{ agentId: string; openChats: number }> {
    const counts = await Promise.all(
      agents.map(async (agentId) => ({
        agentId,
        count: await this.conversationRepo.countOpenByAgent(tenantId, agentId),
      })),
    );

    counts.sort((a, b) => a.count - b.count);
    return { agentId: counts[0].agentId, openChats: counts[0].count };
  }

  /**
   * Capacity-based: like least-busy, but rejects agents who have reached
   * their maximum concurrent chat capacity.
   *
   * If ALL agents are at max capacity, returns null → conversation goes to queue.
   */
  private async capacityBased(
    tenantId: string,
    agents: string[],
    maxCapacity: number,
  ): Promise<{
    agentId: string | null;
    openChats: number;
    allLoads: Array<{ agentId: string; count: number }>;
  }> {
    const counts = await Promise.all(
      agents.map(async (agentId) => ({
        agentId,
        count: await this.conversationRepo.countOpenByAgent(tenantId, agentId),
      })),
    );

    // Filter to only agents under capacity
    const eligible = counts.filter((c) => c.count < maxCapacity);

    if (eligible.length === 0) {
      return { agentId: null, openChats: 0, allLoads: counts };
    }

    // Pick the agent with fewest open chats among eligible
    eligible.sort((a, b) => a.count - b.count);
    return {
      agentId: eligible[0].agentId,
      openChats: eligible[0].count,
      allLoads: counts,
    };
  }

  /**
   * Get available agents from a pool (or all agents if no pool specified).
   * Filters by online presence status.
   */
  private async getAvailableAgents(
    tenantId: string,
    pool?: string[],
  ): Promise<string[]> {
    try {
      const onlineAgents = await this.presenceService.getOnlineAgents(tenantId);
      if (pool && pool.length > 0) {
        return onlineAgents.filter((id) => pool.includes(id));
      }
      return onlineAgents;
    } catch {
      // If presence service fails, return the pool as-is or empty
      return pool ?? [];
    }
  }

  /**
   * Write an audit log entry for the assignment decision.
   */
  private async writeAuditLog(dto: CreateAuditLogDto): Promise<void> {
    try {
      await this.auditLogRepo.create(dto);
    } catch (err) {
      this.logger.error(`Failed to write assignment audit log: ${err.message}`);
    }
  }
}
