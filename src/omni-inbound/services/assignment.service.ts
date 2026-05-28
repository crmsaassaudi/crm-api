import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Model } from 'mongoose';
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
import {
  RoutingRuleEvaluatorService,
  RoutingContext,
} from '../../routing-rules/routing-rule-evaluator.service';

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
  /** Routing context for rule evaluation */
  routingContext?: RoutingContext;
  /**
   * Channel-level auto-assignment override.
   *   - true  → channel explicitly enabled auto-assign (ignores global toggle)
   *   - false → channel explicitly disabled (handled upstream, should not reach here)
   *   - undefined → channel did not set; defer to global toggle
   */
  channelAutoAssignOverride?: boolean;
  /** Allow replacing an existing assigned agent (used by offline fallback). */
  allowReassignment?: boolean;
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
    private readonly routingRuleEvaluator: RoutingRuleEvaluatorService,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(OMNI_STICKY_RETRY_QUEUE)
    private readonly stickyRetryQueue: Queue<StickyRetryJobData>,
    @InjectModel('GroupSchemaClass')
    private readonly groupModel: Model<any>,
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
    this.logger.debug(
      `assignConversation tenantId=${tenantId}, conversationId=${conversationId}`,
    );

    // ── Channel-first auto-assignment hierarchy ───────────────────────
    //
    // Priority:
    //   1. Channel.autoAssign === false → SKIP (handled upstream in triggerAutoAssignment)
    //   2. Channel.autoAssign === true  → ALWAYS assign (skip global check)
    //   3. Channel.autoAssign === undefined → Defer to global toggle
    //      - Global ON  → assign
    //      - Global OFF → queue
    //
    const channelOverride = options.channelAutoAssignOverride;
    this.logger.debug(`channelOverride=${channelOverride ?? 'undefined'}`);

    if (channelOverride === true) {
      // Channel explicitly enabled — proceed regardless of global setting
      this.logger.debug(`Channel override=true → bypassing global toggle`);
    } else if (channelOverride === undefined) {
      // Channel did not set — check global toggle
      this.logger.debug(
        `Channel override=undefined → checking global toggle: autoAssignmentEnabled=${routingConfig.autoAssignmentEnabled}`,
      );
      if (routingConfig.autoAssignmentEnabled === false) {
        this.logger.log(
          `Auto-assignment globally disabled for tenant ${tenantId} ` +
            `and channel did not override — conversation ${conversationId} queued`,
        );
        await this.writeAuditLog({
          tenantId,
          conversationId,
          assignedAgentId: null,
          strategy: 'manual',
          reason:
            'Auto-assignment globally disabled (omni_routing.autoAssignmentEnabled = false) ' +
            'and channel did not override',
          metadata: { channelOverride: 'undefined', globalEnabled: false },
          outcome: 'queued',
        });
        return null;
      }
      this.logger.debug(`Global auto-assign enabled → proceeding`);
    }
    // channelOverride === false is already handled upstream (triggerAutoAssignment)

    // ── Evaluate routing rules to override defaults ───────────────────
    let ruleMatch: Awaited<
      ReturnType<RoutingRuleEvaluatorService['evaluateForTenant']>
    > = null;
    if (options.routingContext) {
      this.logger.debug(`Evaluating routing rules for tenant ${tenantId}`);
      try {
        ruleMatch = await this.routingRuleEvaluator.evaluateForTenant(
          tenantId,
          options.routingContext,
        );
        this.logger.debug(
          `Routing rule matched: strategy=${ruleMatch?.strategy ?? 'none'}, teamId=${ruleMatch?.teamId ?? 'none'}`,
        );
      } catch (err: any) {
        this.logger.warn(
          `Routing rule evaluation failed: ${err.message} — using default routing`,
        );
      }
    } else {
      this.logger.debug(
        `No routingContext provided — skipping rule evaluation`,
      );
    }

    // Normalize strategy: accept both 'round_robin' (DB/settings format)
    // and 'round-robin' (AssignmentService internal format)
    const normalizeStrategy = (s: string | undefined): AssignmentStrategy => {
      const map: Record<string, AssignmentStrategy> = {
        round_robin: 'round-robin',
        least_busy: 'least-busy',
        capacity_based: 'capacity-based',
      };
      return (map[s as string] ?? s ?? 'round-robin') as AssignmentStrategy;
    };

    const strategy: AssignmentStrategy = normalizeStrategy(
      ruleMatch?.strategy ??
        options.strategy ??
        (routingConfig.defaultStrategy as string) ??
        'round-robin',
    );
    const tenantMaxCapacity: number =
      routingConfig.defaultMaxCapacity ?? FALLBACK_MAX_CAPACITY;
    const requiredSkills: string[] =
      ruleMatch?.requiredSkills ?? options.requiredSkills ?? [];

    // If a routing rule matched and specifies a team, resolve the agent pool
    // from that team (group members) and intersect with channel pool.
    let effectivePool = options.agentPool;
    if (ruleMatch?.teamId) {
      this.logger.debug(
        `Routing rule "${ruleMatch.ruleName}" matched — teamId=${ruleMatch.teamId}, strategy=${ruleMatch.strategy}`,
      );
      const teamMembers = await this.resolveGroupMembers(ruleMatch.teamId);
      if (teamMembers.length > 0) {
        if (effectivePool && effectivePool.length > 0) {
          // Intersect: only agents in BOTH channel pool AND routing rule team
          const teamSet = new Set(teamMembers);
          effectivePool = effectivePool.filter((id) => teamSet.has(id));
          this.logger.debug(
            `Team pool intersected with channel pool: ${effectivePool.length} agents eligible`,
          );
        } else {
          effectivePool = teamMembers;
        }
      }
    }

    this.logger.debug(
      `Strategy resolved: ${strategy}, tenantMaxCapacity=${tenantMaxCapacity}, requiredSkills=[${requiredSkills.join(',')}], effectivePool size=${effectivePool?.length ?? 'all'}`,
    );

    // Get available agents (online/available status)
    const availableAgents = await this.getAvailableAgents(
      tenantId,
      effectivePool,
    );
    this.logger.debug(
      `Available agents online: count=${availableAgents.length}`,
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
    if (requiredSkills.length > 0 && routingConfig.skillBasedRoutingEnabled) {
      eligibleAgents = await this.filterBySkills(
        availableAgents,
        requiredSkills,
      );
      if (eligibleAgents.length === 0) {
        this.logger.warn(
          `No agents with required skills ${requiredSkills.join(', ')} — falling back to full pool`,
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
        const orderedAgents = await this.roundRobinOrder(
          tenantId,
          eligibleAgents,
        );
        selectedAgent = await this.reserveCandidate(
          tenantId,
          orderedAgents,
          'round-robin',
        );
        reason = `Round-robin selected agent (index from Redis counter)`;
        metadata = { pool: eligibleAgents };
        break;
      }
      case 'least-busy': {
        selectedAgent = await this.reserveCandidate(
          tenantId,
          eligibleAgents,
          'least-busy',
        );
        reason = `Least-busy: reserved the lowest-load eligible agent from Redis`;
        metadata = { pool: eligibleAgents };
        break;
      }
      case 'capacity-based': {
        selectedAgent = await this.reserveCandidate(
          tenantId,
          eligibleAgents,
          'capacity-based',
          tenantMaxCapacity,
        );
        if (selectedAgent) {
          reason = `Capacity-based: reserved agent below capacity via Redis`;
        } else {
          reason = `All agents at max capacity — conversation queued`;
        }
        metadata = {
          pool: eligibleAgents,
          tenantMaxCapacity,
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
      const committed = options.allowReassignment
        ? await this.conversationRepo.updateAssignment(
            conversationId,
            selectedAgent,
          )
        : typeof (this.conversationRepo as any).assignIfUnassigned ===
            'function'
          ? await this.conversationRepo.assignIfUnassigned(
              conversationId,
              selectedAgent,
            )
          : await this.conversationRepo.updateAssignment(
              conversationId,
              selectedAgent,
            );

      if (committed === null) {
        await this.presenceService.releaseConversation?.(
          tenantId,
          selectedAgent,
        );
        reason =
          'Assignment reservation rolled back because the conversation was already assigned or inactive';
        selectedAgent = null;
      }
    }

    if (selectedAgent) {
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

    const presence = await this.presenceService.getPresence(
      tenantId,
      previousAgentId,
    );
    const agentCapacity =
      presence?.maxCapacity ??
      (tenantMaxCapacity > 0 ? tenantMaxCapacity : FALLBACK_MAX_CAPACITY);
    const openChats =
      presence?.activeConversations ??
      (await this.conversationRepo.countOpenByAgent(tenantId, previousAgentId));

    const reserve = (this.presenceService as any).reserveAgentFromCandidates;
    const reservedAgent =
      typeof reserve === 'function'
        ? await reserve.call(this.presenceService, tenantId, [previousAgentId])
        : openChats < agentCapacity
          ? previousAgentId
          : null;

    if (!reservedAgent) {
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
              jobId: `sticky-retry-${conversationId}-${Date.now()}`,
              delay: stickyWaitMinutes * 60 * 1000,
              removeOnComplete: true,
              removeOnFail: { count: 100 },
              attempts: 2,
              backoff: { type: 'fixed', delay: 5000 },
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

    const committed = options.allowReassignment
      ? await this.conversationRepo.updateAssignment(
          conversationId,
          previousAgentId,
        )
      : typeof (this.conversationRepo as any).assignIfUnassigned === 'function'
        ? await this.conversationRepo.assignIfUnassigned(
            conversationId,
            previousAgentId,
          )
        : await this.conversationRepo.updateAssignment(
            conversationId,
            previousAgentId,
          );

    if (committed === null) {
      await this.presenceService.releaseConversation?.(
        tenantId,
        previousAgentId,
      );
      return null;
    }

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

  private async reserveCandidate(
    tenantId: string,
    agents: string[],
    strategy: AssignmentStrategy,
    tenantMaxCapacity = FALLBACK_MAX_CAPACITY,
  ): Promise<string | null> {
    const reserve = (this.presenceService as any).reserveAgentFromCandidates;
    if (typeof reserve === 'function') {
      return reserve.call(this.presenceService, tenantId, agents);
    }

    if (strategy === 'least-busy') {
      return (await this.leastBusy(tenantId, agents)).agentId;
    }

    if (strategy === 'capacity-based') {
      return (await this.capacityBased(tenantId, agents, tenantMaxCapacity))
        .agentId;
    }

    return agents[0] ?? null;
  }

  /**
   * Round-robin: use a Redis counter to cycle through the agent pool.
   */
  private async roundRobinOrder(
    tenantId: string,
    agents: string[],
  ): Promise<string[]> {
    const key = `omni:rr:${tenantId}`;
    const counter = await this.redis.incr(key);
    // Set TTL on first creation (24h)
    if (counter === 1) {
      await this.redis.expire(key, 86400);
    }
    const index = (counter - 1) % agents.length;
    return [...agents.slice(index), ...agents.slice(0, index)];
  }

  /**
   * Least-busy: pick the agent with the fewest open/pending conversations.
   * Uses a single aggregation pipeline instead of per-agent queries.
   */
  private async leastBusy(
    tenantId: string,
    agents: string[],
  ): Promise<{ agentId: string; openChats: number }> {
    const countMap = await this.conversationRepo.countOpenByAgents(
      tenantId,
      agents,
    );

    const counts = agents.map((agentId) => ({
      agentId,
      count: countMap.get(agentId) ?? 0,
    }));

    counts.sort((a, b) => a.count - b.count);
    return { agentId: counts[0].agentId, openChats: counts[0].count };
  }

  /**
   * Capacity-based: like least-busy, but rejects agents who have reached
   * their maximum concurrent chat capacity (dynamic per-agent).
   *
   * Uses a single aggregation pipeline for counts instead of per-agent queries.
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
    // Batch: single aggregation for all agent counts
    const countMap = await this.conversationRepo.countOpenByAgents(
      tenantId,
      agents,
    );

    // Resolve capacities (still per-agent due to Redis presence check,
    // but these are cheap in-memory lookups, not DB queries)
    const counts = await Promise.all(
      agents.map(async (agentId) => {
        const capacity = await this.resolveAgentCapacity(
          tenantId,
          agentId,
          tenantMaxCapacity,
        );
        return {
          agentId,
          count: countMap.get(agentId) ?? 0,
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
        const poolSet = new Set(pool);
        return onlineAgents.filter((id) => poolSet.has(id));
      }
      return onlineAgents;
    } catch {
      // If presence service fails, return the pool as-is or empty
      return pool ?? [];
    }
  }

  /**
   * Resolve group (team) members from MongoDB.
   * Accepts a single groupId or an array of groupIds.
   * Returns deduplicated list of member user IDs.
   */
  async resolveGroupMembers(
    groupIdOrIds: string | string[],
  ): Promise<string[]> {
    const ids = Array.isArray(groupIdOrIds) ? groupIdOrIds : [groupIdOrIds];
    if (ids.length === 0) return [];

    try {
      const groups = await this.groupModel
        .find({ _id: { $in: ids } })
        .lean()
        .exec();

      const allMembers = groups.flatMap((g: any) =>
        (g.memberIds ?? g.members ?? []).map(String),
      );

      return [...new Set(allMembers)];
    } catch (err: any) {
      this.logger.warn(
        `Failed to resolve group members for ${ids.join(',')}: ${err.message}`,
      );
      return [];
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
