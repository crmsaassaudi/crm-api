import { Injectable, Logger, Inject } from '@nestjs/common';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import type Redis from 'ioredis';
import { ConversationRepository } from '../repositories/conversation.repository';
import { AgentPresenceService } from './agent-presence.service';

export type AssignmentStrategy = 'round-robin' | 'least-busy' | 'manual';

/**
 * AssignmentService — auto-assigns conversations to agents based on
 * configurable strategies. Called when a new conversation is created.
 *
 * Strategies:
 *   - round-robin: cycles through available agents using a Redis counter
 *   - least-busy: picks the agent with fewest open conversations
 *   - manual: no auto-assign — goes to queue for manual pickup
 */
@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly presenceService: AgentPresenceService,
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
  ): Promise<string | null> {
    // Get available agents (online/available status)
    const availableAgents = await this.getAvailableAgents(tenantId, agentPool);

    if (availableAgents.length === 0) {
      this.logger.warn(
        `No available agents for tenant ${tenantId} — conversation ${conversationId} goes to queue`,
      );
      return null;
    }

    let selectedAgent: string | null = null;

    switch (strategy) {
      case 'round-robin':
        selectedAgent = await this.roundRobin(tenantId, availableAgents);
        break;
      case 'least-busy':
        selectedAgent = await this.leastBusy(tenantId, availableAgents);
        break;
      case 'manual':
      default:
        return null;
    }

    if (selectedAgent) {
      await this.conversationRepo.updateAssignment(conversationId, selectedAgent);
      this.logger.log(
        `Auto-assigned conversation ${conversationId} to agent ${selectedAgent} (${strategy})`,
      );
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
  ): Promise<string> {
    const counts = await Promise.all(
      agents.map(async (agentId) => ({
        agentId,
        count: await this.conversationRepo.countOpenByAgent(tenantId, agentId),
      })),
    );

    counts.sort((a, b) => a.count - b.count);
    return counts[0].agentId;
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
}
