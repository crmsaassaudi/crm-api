import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import {
  AgentPresence,
  AgentStatus,
  agentPresenceKey,
  HEARTBEAT_TTL_SECONDS,
} from '../domain/agent-presence';

/**
 * Manages agent presence and capacity in Redis.
 *
 * Each agent's presence is stored as a JSON hash with a TTL.
 * If the TTL expires (heartbeat missed), the agent is considered offline.
 */
@Injectable()
export class AgentPresenceService {
  private readonly logger = new Logger(AgentPresenceService.name);
  private static readonly DEFAULT_MAX_CAPACITY = 10;

  constructor(private readonly redis: RedisService) {}

  /**
   * Set the agent's status and refresh their heartbeat TTL.
   */
  async updateStatus(
    tenantId: string,
    userId: string,
    status: AgentStatus,
    socketId?: string,
  ): Promise<AgentPresence> {
    const key = agentPresenceKey(tenantId, userId);
    const client = this.redis.getClient();

    // Try to get existing data first
    const existing = await this.getPresence(tenantId, userId);

    const presence: AgentPresence = {
      userId,
      tenantId,
      status,
      activeConversations: existing?.activeConversations ?? 0,
      maxCapacity: existing?.maxCapacity ?? AgentPresenceService.DEFAULT_MAX_CAPACITY,
      lastHeartbeat: new Date(),
      socketId: socketId ?? existing?.socketId,
    };

    await client.setex(key, HEARTBEAT_TTL_SECONDS, JSON.stringify(presence));

    this.logger.log(`Agent ${userId} status → ${status}`);
    return presence;
  }

  /**
   * Refresh heartbeat TTL without changing status.
   * Called periodically by the frontend (every 30s).
   */
  async heartbeat(tenantId: string, userId: string): Promise<void> {
    const key = agentPresenceKey(tenantId, userId);
    const client = this.redis.getClient();

    // Refresh TTL if the key exists
    const exists = await client.exists(key);
    if (exists) {
      // Update the lastHeartbeat timestamp
      const raw = await client.get(key);
      if (raw) {
        const presence: AgentPresence = JSON.parse(raw);
        presence.lastHeartbeat = new Date();
        await client.setex(key, HEARTBEAT_TTL_SECONDS, JSON.stringify(presence));
      }
    } else {
      // Key expired → agent went offline, re-register as available
      await this.updateStatus(tenantId, userId, 'available');
    }
  }

  /**
   * Get a single agent's presence.
   */
  async getPresence(
    tenantId: string,
    userId: string,
  ): Promise<AgentPresence | null> {
    const key = agentPresenceKey(tenantId, userId);
    const client = this.redis.getClient();
    const raw = await client.get(key);
    return raw ? JSON.parse(raw) : null;
  }

  /**
   * Get all available agents (status = available, capacity not full).
   */
  async getAvailableAgents(tenantId: string): Promise<AgentPresence[]> {
    const allAgents = await this.getAllAgents(tenantId);
    return allAgents.filter(
      (a) =>
        a.status === 'available' &&
        a.activeConversations < a.maxCapacity,
    );
  }

  /**
   * Get all agents for a tenant (any status).
   */
  async getAllAgents(tenantId: string): Promise<AgentPresence[]> {
    const client = this.redis.getClient();
    const pattern = `omni:agent:presence:${tenantId}:*`;
    const keys = await client.keys(pattern);

    if (keys.length === 0) return [];

    const pipeline = client.pipeline();
    keys.forEach((k) => pipeline.get(k));
    const results = await pipeline.exec();

    const agents: AgentPresence[] = [];
    for (const result of results ?? []) {
      const [err, raw] = result;
      if (!err && raw) {
        agents.push(JSON.parse(raw as string));
      }
    }

    return agents;
  }

  /**
   * Increment the active conversation count for an agent.
   * Returns false if the agent is at capacity.
   */
  async assignConversation(
    tenantId: string,
    userId: string,
  ): Promise<boolean> {
    const presence = await this.getPresence(tenantId, userId);
    if (!presence) return false;
    if (presence.activeConversations >= presence.maxCapacity) return false;

    presence.activeConversations += 1;

    // If at capacity, auto-switch to busy
    if (presence.activeConversations >= presence.maxCapacity) {
      presence.status = 'busy';
    }

    const key = agentPresenceKey(tenantId, userId);
    const client = this.redis.getClient();
    await client.setex(key, HEARTBEAT_TTL_SECONDS, JSON.stringify(presence));

    this.logger.log(
      `Assigned conversation to agent ${userId} ` +
        `(${presence.activeConversations}/${presence.maxCapacity})`,
    );
    return true;
  }

  /**
   * Decrement the active conversation count for an agent
   * (when a conversation is resolved/closed).
   */
  async releaseConversation(
    tenantId: string,
    userId: string,
  ): Promise<void> {
    const presence = await this.getPresence(tenantId, userId);
    if (!presence) return;

    presence.activeConversations = Math.max(0, presence.activeConversations - 1);

    // If was busy due to capacity, let them go back to available
    if (presence.status === 'busy' && presence.activeConversations < presence.maxCapacity) {
      presence.status = 'available';
    }

    const key = agentPresenceKey(tenantId, userId);
    const client = this.redis.getClient();
    await client.setex(key, HEARTBEAT_TTL_SECONDS, JSON.stringify(presence));
  }

  /**
   * Remove an agent's presence entirely (e.g. on explicit logout / disconnect).
   */
  async removePresence(tenantId: string, userId: string): Promise<void> {
    const key = agentPresenceKey(tenantId, userId);
    const client = this.redis.getClient();
    await client.del(key);
    this.logger.log(`Agent ${userId} removed from presence`);
  }
}
