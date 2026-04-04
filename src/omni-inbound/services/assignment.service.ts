import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import type Redis from 'ioredis';
import { ConversationRepository } from '../repositories/conversation.repository';
import { AgentPresenceService } from './agent-presence.service';
import {
  AssignmentAuditLogRepository,
  CreateAuditLogDto,
} from '../repositories/assignment-audit-log.repository';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { UsersService } from '../../users/users.service';
import { OMNI_STICKY_RETRY_QUEUE } from '../queue/omni-sticky-queue.constants';
import type { StickyRetryJobData } from '../queue/sticky-retry.processor';

export type AssignmentStrategy =
  | 'round-robin'
  | 'least-busy'
  | 'capacity-based'
  | 'sticky'
  | 'manual';

/** Hardcoded fallback when no tenant setting or per-agent setting is available */
const FALLBACK_MAX_CAPACITY = 10;

export interface AssignmentOptions {
  strategy?: AssignmentStrategy;
  agentPool?: string[];
  contactId?: string | null;
  externalSenderId?: string | null;
  requiredSkills?: string[];
  /** Skip sticky routing (used by sticky-retry processor to avoid infinite loop) */
  skipSticky?: boolean;
}

/**
 * AssignmentService — auto-assigns conversations to agents based on
 * configurable strategies. Called when a new conversation is created.
 *
 * Strategies:
 *   - round-robin: cycles through available agents using a Redis counter
 *   - least-busy: picks the agent with fewest open conversations
 *   - capacity-based: like least-busy but caps each agent to a dynamic max capacity
 *   - sticky: prioritizes the agent who last handled this customer
 *   - manual: no auto-assign — goes to queue for manual pickup
 *
 * Dynamic capacity:
 *   1. Per-agent capacity (user.omniMaxCapacity) — stored in Redis presence
 *   2. Tenant-level default (crm-settings: omni_routing.defaultMaxCapacity)
 *   3. Hardcoded fallback (10)
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
    private readonly settingsService: CrmSettingsService,
    private readonly usersService: UsersService,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(OMNI_STICKY_RETRY_QUEUE)
    private readonly stickyRetryQueue: Queue<StickyRetryJobData>,
  ) {}

  /**
   * Auto-assign a conversation to an available agent.
   * Returns the assigned agent ID, or null if no agent is available.
   */
  async assignConversation(
    tenantId: string,
    conversationId: string,
    strategyOrOptions?: AssignmentStrategy | AssignmentOptions,
    agentPool?: string[],
  ): Promise<string | null> {
    // ── Normalize arguments (backward compat with old 3-arg calls) ─────
    let options: AssignmentOptions;
    if (typeof strategyOrOptions === 'string') {
      options = { strategy: strategyOrOptions, agentPool };
    } else {
      options = strategyOrOptions ?? {};
    }

    // ── Resolve tenant routing config ─────────────────────────────────
    const routingConfig = await this.getRoutingConfig(tenantId);
    const strategy: AssignmentStrategy =
      options.strategy ??
      (routingConfig.defaultStrategy as AssignmentStrategy) ??
      'round-robin';
    const tenantMaxCapacity: number =
      routingConfig.defaultMaxCapacity ?? FALLBACK_MAX_CAPACITY;

    // Get available agents (online/available status)
    const availableAgents = await this.getAvailableAgents(
      tenantId,
      options.agentPool,
    );

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
        metadata: { poolSize: options.agentPool?.length ?? 0 },
        outcome: 'queued',
      });
      return null;
    }

    // ── Sticky routing: try the previous agent first ──────────────────
    if (
      !options.skipSticky &&
      (strategy === 'sticky' ||
        (routingConfig.stickyRoutingEnabled && strategy !== 'manual'))
    ) {
      const stickyResult = await this.tryStickyRouting(
        tenantId,
        conversationId,
        availableAgents,
        options,
        routingConfig,
        tenantMaxCapacity,
      );
      if (stickyResult === '__sticky_waiting__') {
        // Conversation is waiting for the preferred agent — delayed retry scheduled
        await this.writeAuditLog({
          tenantId,
          conversationId,
          assignedAgentId: null,
          strategy: 'sticky',
          reason: `Sticky wait-time: waiting for preferred agent (max ${routingConfig.stickyWaitTimeMinutes ?? 3} min)`,
          metadata: {
            stickyWaitTimeMinutes: routingConfig.stickyWaitTimeMinutes ?? 3,
          },
          outcome: 'queued',
        });
        return null;
      }
      if (stickyResult) return stickyResult;
      // If sticky fails, fall through to the configured strategy
    }

    let selectedAgent: string | null = null;
    let reason = '';
    let metadata: Record<string, any> = {};

    // ── Filter by required skills if present ──────────────────────────
    let eligibleAgents = availableAgents;
    if (
      options.requiredSkills &&
      options.requiredSkills.length > 0 &&
      routingConfig.skillBasedRoutingEnabled
    ) {
      eligibleAgents = await this.filterBySkills(
        availableAgents,
        options.requiredSkills,
      );
      if (eligibleAgents.length === 0) {
        this.logger.warn(
          `No agents with required skills ${options.requiredSkills.join(', ')} — falling back to full pool`,
        );
        eligibleAgents = availableAgents;
      }
    }

    const effectiveStrategy =
      strategy === 'sticky'
        ? ((routingConfig.fallbackStrategy as AssignmentStrategy) ??
          'round-robin')
        : strategy;

    switch (effectiveStrategy) {
      case 'round-robin': {
        selectedAgent = await this.roundRobin(tenantId, eligibleAgents);
        reason = `Round-robin selected agent (index from Redis counter)`;
        metadata = { pool: eligibleAgents };
        break;
      }
      case 'least-busy': {
        const result = await this.leastBusy(tenantId, eligibleAgents);
        selectedAgent = result.agentId;
        reason = `Least-busy: agent has ${result.openChats} open chats (fewest in pool)`;
        metadata = { pool: eligibleAgents, openChats: result.openChats };
        break;
      }
      case 'capacity-based': {
        const result = await this.capacityBased(
          tenantId,
          eligibleAgents,
          tenantMaxCapacity,
        );
        selectedAgent = result.agentId;
        if (selectedAgent) {
          reason = `Capacity-based: agent has ${result.openChats}/${result.agentCapacity} open chats`;
        } else {
          reason = `All agents at max capacity — conversation queued`;
        }
        metadata = {
          pool: eligibleAgents,
          tenantMaxCapacity,
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
        `Auto-assigned conversation ${conversationId} to agent ${selectedAgent} (${effectiveStrategy})`,
      );
      await this.writeAuditLog({
        tenantId,
        conversationId,
        assignedAgentId: selectedAgent,
        strategy: effectiveStrategy,
        reason,
        metadata,
        outcome: 'assigned',
      });
    } else {
      this.logger.warn(
        `No agent available under ${effectiveStrategy} for conversation ${conversationId} — queued`,
      );
      await this.writeAuditLog({
        tenantId,
        conversationId,
        assignedAgentId: null,
        strategy: effectiveStrategy,
        reason,
        metadata,
        outcome: 'queued',
      });
    }

    return selectedAgent;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Sticky Routing
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Try to assign the conversation to the agent who last handled this customer.
   * Returns the agent ID if successful, or null if sticky routing fails.
   */
  private async tryStickyRouting(
    tenantId: string,
    conversationId: string,
    availableAgents: string[],
    options: AssignmentOptions,
    routingConfig: any,
    tenantMaxCapacity: number,
  ): Promise<string | null> {
    // Find the previous agent for this customer
    let previousAgentId: string | null = null;
    let lookupSource = '';

    if (options.contactId) {
      const lastConv = await this.conversationRepo.findLastResolvedByContact(
        tenantId,
        options.contactId,
      );
      if (lastConv?.assignedAgentId) {
        // Check if the conversation is within the sticky timeout
        const timeoutHours = routingConfig.stickyTimeoutHours ?? 72;
        const resolvedAt = lastConv.resolvedAt ?? lastConv.updatedAt;
        const hoursSinceResolved =
          (Date.now() - new Date(resolvedAt).getTime()) / (1000 * 60 * 60);

        if (hoursSinceResolved <= timeoutHours) {
          previousAgentId = lastConv.assignedAgentId;
          lookupSource = 'contactId';
        }
      }
    }

    if (!previousAgentId && options.externalSenderId) {
      const lastConv = await this.conversationRepo.findLastResolvedBySender(
        tenantId,
        options.externalSenderId,
      );
      if (lastConv?.assignedAgentId) {
        const timeoutHours = routingConfig.stickyTimeoutHours ?? 72;
        const resolvedAt = lastConv.resolvedAt ?? lastConv.updatedAt;
        const hoursSinceResolved =
          (Date.now() - new Date(resolvedAt).getTime()) / (1000 * 60 * 60);

        if (hoursSinceResolved <= timeoutHours) {
          previousAgentId = lastConv.assignedAgentId;
          lookupSource = 'externalSenderId';
        }
      }
    }

    if (!previousAgentId) return null;

    // Check if the previous agent is available and has capacity
    if (!availableAgents.includes(previousAgentId)) {
      this.logger.debug(
        `Sticky routing: previous agent ${previousAgentId} is not available — falling back`,
      );
      return null;
    }

    const agentCapacity = await this.resolveAgentCapacity(
      tenantId,
      previousAgentId,
      tenantMaxCapacity,
    );
    const openChats = await this.conversationRepo.countOpenByAgent(
      tenantId,
      previousAgentId,
    );

    if (openChats >= agentCapacity) {
      // Check if sticky wait-time is configured
      const stickyWaitMinutes = routingConfig.stickyWaitTimeMinutes ?? 0;

      if (stickyWaitMinutes > 0) {
        this.logger.log(
          `Sticky routing: previous agent ${previousAgentId} is at capacity ` +
            `(${openChats}/${agentCapacity}) — waiting ${stickyWaitMinutes} min`,
        );

        // Schedule a delayed retry job
        const fallbackStrategy =
          (routingConfig.fallbackStrategy as string) ?? 'round-robin';
        try {
          await this.stickyRetryQueue.add(
            'sticky-retry',
            {
              tenantId,
              conversationId,
              stickyAgentId: previousAgentId,
              fallbackStrategy,
            },
            {
              jobId: `sticky-retry:${conversationId}`,
              delay: stickyWaitMinutes * 60 * 1000,
            },
          );
        } catch (err: any) {
          this.logger.error(
            `Failed to schedule sticky retry for ${conversationId}: ${err.message}`,
          );
          return null; // Fall through to normal assignment
        }

        return '__sticky_waiting__';
      }

      this.logger.debug(
        `Sticky routing: previous agent ${previousAgentId} is at capacity (${openChats}/${agentCapacity}) — falling back`,
      );
      return null;
    }

    // Assign!
    await this.conversationRepo.updateAssignment(
      conversationId,
      previousAgentId,
    );
    this.logger.log(
      `Sticky-assigned conversation ${conversationId} to previous agent ${previousAgentId} (lookup: ${lookupSource})`,
    );
    await this.writeAuditLog({
      tenantId,
      conversationId,
      assignedAgentId: previousAgentId,
      strategy: 'sticky',
      reason: `Sticky routing: reassigned to previous agent (${lookupSource}, ${openChats}/${agentCapacity} chats)`,
      metadata: {
        previousAgentId,
        lookupSource,
        openChats,
        agentCapacity,
      },
      outcome: 'assigned',
    });

    return previousAgentId;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Core Strategies
  // ────────────────────────────────────────────────────────────────────────

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
   * their maximum concurrent chat capacity (dynamic per-agent).
   *
   * If ALL agents are at max capacity, returns null → conversation goes to queue.
   */
  private async capacityBased(
    tenantId: string,
    agents: string[],
    tenantMaxCapacity: number,
  ): Promise<{
    agentId: string | null;
    openChats: number;
    agentCapacity: number;
    allLoads: Array<{ agentId: string; count: number; capacity: number }>;
  }> {
    const counts = await Promise.all(
      agents.map(async (agentId) => {
        const capacity = await this.resolveAgentCapacity(
          tenantId,
          agentId,
          tenantMaxCapacity,
        );
        return {
          agentId,
          count: await this.conversationRepo.countOpenByAgent(
            tenantId,
            agentId,
          ),
          capacity,
        };
      }),
    );

    // Filter to only agents under capacity
    const eligible = counts.filter((c) => c.count < c.capacity);

    if (eligible.length === 0) {
      return {
        agentId: null,
        openChats: 0,
        agentCapacity: 0,
        allLoads: counts,
      };
    }

    // Pick the agent with fewest open chats among eligible
    eligible.sort((a, b) => a.count - b.count);
    return {
      agentId: eligible[0].agentId,
      openChats: eligible[0].count,
      agentCapacity: eligible[0].capacity,
      allLoads: counts,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Resolve the effective max capacity for a specific agent.
   * Priority: per-agent (Redis presence) → tenant default → hardcoded fallback.
   */
  private async resolveAgentCapacity(
    tenantId: string,
    agentId: string,
    tenantMaxCapacity: number,
  ): Promise<number> {
    const presence = await this.presenceService.getPresence(tenantId, agentId);
    if (presence?.maxCapacity && presence.maxCapacity > 0) {
      return presence.maxCapacity;
    }
    return tenantMaxCapacity > 0 ? tenantMaxCapacity : FALLBACK_MAX_CAPACITY;
  }

  /**
   * Filter agents by required skills. An agent must have ALL required skills.
   */
  private async filterBySkills(
    agentIds: string[],
    requiredSkills: string[],
  ): Promise<string[]> {
    const users = await this.usersService.findByIds(agentIds);
    return users
      .filter((user) => {
        const agentSkills = user.skills ?? [];
        return requiredSkills.every((skill) =>
          agentSkills.some((s) => s.toLowerCase() === skill.toLowerCase()),
        );
      })
      .map((user) => user.id.toString());
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
   * Get tenant routing configuration from CRM settings.
   * Falls back to sensible defaults if settings not found.
   */
  private async getRoutingConfig(tenantId: string): Promise<any> {
    try {
      const config = await this.settingsService.getSetting(
        'omni_routing',
        tenantId,
      );
      return config ?? {};
    } catch {
      return {};
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
