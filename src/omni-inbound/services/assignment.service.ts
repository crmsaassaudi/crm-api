import {
  Injectable,
  Logger,
  Inject,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
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
} from '../repositories/omni-assignment-audit-log.repository';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { UsersService } from '../../users/users.service';
import { OMNI_STICKY_RETRY_QUEUE } from '../queue/omni-sticky-queue.constants';
import type { StickyRetryJobData } from '../queue/sticky-retry.processor';
import {
  RoutingRuleEvaluatorService,
  RoutingContext,
} from '../../routing-rules/routing-rule-evaluator.service';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { OmniEvents, ConversationQueuedEvent } from '../domain/omni-events';

export type AssignmentStrategy =
  | 'round-robin'
  | 'least-busy'
  | 'capacity-based'
  | 'sticky'
  | 'manual';

/** Hardcoded fallback when no tenant setting or per-agent setting is available */
const FALLBACK_MAX_CAPACITY = 10;

/**
 * Sentinel returned by tryStickyRouting() when the preferred agent is at
 * capacity and a delayed retry has been scheduled. Callers check this value
 * to distinguish "no agent found" (null) from "waiting for preferred agent".
 */
const STICKY_WAITING_SENTINEL = '__sticky_waiting__';

/** Predicate that returns true when a resolved timestamp is within the sticky timeout window. */
type StickyTimeoutFn = (resolvedAt: string | Date | undefined) => boolean;

/**
 * Per-channel routing override. Every field is OPTIONAL — an undefined field
 * means "inherit from the global omni_routing setting". Stored on the channel
 * as `channel.config.routing`. This lets, e.g., WhatsApp run `sticky` while
 * every other channel inherits the tenant default, without duplicating the
 * unrelated settings.
 */
export interface ChannelRoutingOverride {
  defaultStrategy?: AssignmentStrategy;
  defaultMaxCapacity?: number;
  stickyRoutingEnabled?: boolean;
  stickyTimeoutHours?: number;
  stickyWaitTimeMinutes?: number;
  fallbackStrategy?: AssignmentStrategy;
  skillBasedRoutingEnabled?: boolean;
}

/** Fully-resolved routing config — every routing-decision field is concrete. */
export interface ResolvedRoutingConfig {
  defaultStrategy: AssignmentStrategy;
  defaultMaxCapacity: number;
  stickyRoutingEnabled: boolean;
  stickyTimeoutHours: number;
  stickyWaitTimeMinutes: number;
  fallbackStrategy: AssignmentStrategy;
  skillBasedRoutingEnabled: boolean;
}

/**
 * Resolve the effective routing config field-by-field:
 *   channel override ?? global setting ?? hardcoded default.
 *
 * Per-field resolution (not per-object) is deliberate: a channel may override
 * a single field and inherit the rest. This is the single seam through which
 * ALL routing-decision settings flow, so adding a new per-channel field is a
 * one-line change here.
 *
 * NOTE: `autoAssignmentEnabled` is intentionally NOT resolved here — the
 * channel-first auto-assign gate is handled separately via
 * AssignmentOptions.channelAutoAssignOverride (see assignConversation).
 */
export function mergeRoutingConfig(
  global: any,
  channel?: ChannelRoutingOverride,
): ResolvedRoutingConfig {
  const g = global ?? {};
  const c = channel ?? {};
  return {
    defaultStrategy:
      c.defaultStrategy ??
      (g.defaultStrategy as AssignmentStrategy) ??
      'round-robin',
    defaultMaxCapacity:
      c.defaultMaxCapacity ?? g.defaultMaxCapacity ?? FALLBACK_MAX_CAPACITY,
    stickyRoutingEnabled:
      c.stickyRoutingEnabled ?? g.stickyRoutingEnabled ?? false,
    stickyTimeoutHours: c.stickyTimeoutHours ?? g.stickyTimeoutHours ?? 72,
    // Default 0 preserves the legacy "unset → no wait window" gate semantics.
    stickyWaitTimeMinutes:
      c.stickyWaitTimeMinutes ?? g.stickyWaitTimeMinutes ?? 0,
    fallbackStrategy:
      c.fallbackStrategy ??
      (g.fallbackStrategy as AssignmentStrategy) ??
      'round-robin',
    skillBasedRoutingEnabled:
      c.skillBasedRoutingEnabled ?? g.skillBasedRoutingEnabled ?? false,
  };
}

/**
 * Normalize strategy strings: accept both 'round_robin' (DB/settings format)
 * and 'round-robin' (AssignmentService internal format).
 */
function normalizeStrategy(s: string | undefined): AssignmentStrategy {
  const map: Record<string, AssignmentStrategy> = {
    round_robin: 'round-robin',
    least_busy: 'least-busy',
    capacity_based: 'capacity-based',
  };
  return (map[s as string] ?? s ?? 'round-robin') as AssignmentStrategy;
}

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
  /**
   * Per-channel routing overrides (strategy, capacity, sticky, skills).
   * Merged over the global omni_routing config via mergeRoutingConfig().
   * Undefined fields inherit from global.
   */
  channelRoutingOverride?: ChannelRoutingOverride;
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
export class AssignmentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AssignmentService.name);

  /** In-memory cache: tenantId → { config, expiresAt } for routing settings */
  private readonly routingConfigCache = new Map<
    string,
    { config: any; expiresAt: number }
  >();

  /** Config cache TTL — 5 minutes (backstop; primary invalidation is event-driven) */
  private readonly CONFIG_CACHE_TTL_MS = 5 * 60_000;

  /**
   * Redis pub/sub channel for cross-instance routing-config cache invalidation.
   * When an admin changes omni_routing settings, the API pod that served the
   * request publishes the tenantId here so EVERY pod drops its local cache,
   * not just the one that handled the HTTP request.
   */
  private static readonly CONFIG_INVALIDATION_CHANNEL =
    'omni:routing-config:invalidate';

  /** Dedicated subscriber connection (ioredis requires a separate conn for SUBSCRIBE). */
  private configInvalidationSub?: Redis;

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
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // Cross-instance config-cache invalidation (Task 2.1)
  // ────────────────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    try {
      this.configInvalidationSub = this.redis.duplicate();
      await this.configInvalidationSub.subscribe(
        AssignmentService.CONFIG_INVALIDATION_CHANNEL,
      );
      this.configInvalidationSub.on('message', (_channel, message) => {
        // message = tenantId, or '*' to flush the entire cache
        if (!message || message === '*') {
          this.routingConfigCache.clear();
          this.logger.debug('Routing config cache flushed (all tenants)');
          return;
        }
        this.routingConfigCache.delete(message);
        this.logger.debug(`Routing config cache invalidated for ${message}`);
      });
      this.logger.log(
        `Subscribed to ${AssignmentService.CONFIG_INVALIDATION_CHANNEL} for config invalidation`,
      );
    } catch (err: any) {
      // Non-fatal: the 5-min TTL still bounds staleness if pub/sub is unavailable.
      this.logger.error(
        `Failed to subscribe to config invalidation channel: ${err.message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.configInvalidationSub) {
      try {
        await this.configInvalidationSub.unsubscribe(
          AssignmentService.CONFIG_INVALIDATION_CHANNEL,
        );
        await this.configInvalidationSub.quit();
      } catch {
        // best-effort cleanup
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Sticky-history cache (Task 3.3)
  // ────────────────────────────────────────────────────────────────────────

  private stickyContactKey(tenantId: string, contactId: string): string {
    return `omni:sticky:${tenantId}:c:${contactId}`;
  }

  private stickySenderKey(tenantId: string, senderId: string): string {
    return `omni:sticky:${tenantId}:s:${senderId}`;
  }

  /**
   * On resolve/close, cache the agent who handled this customer so sticky
   * routing can look them up in Redis instead of querying MongoDB on every
   * subsequent inbound message. TTL = the tenant's stickyTimeoutHours, so the
   * key self-expires exactly when sticky would no longer apply.
   */
  @OnEvent('omni.conversation.status_changed')
  async handleConversationResolvedForSticky(event: {
    tenantId: string;
    conversationId: string;
    status: string;
  }): Promise<void> {
    if (event?.status !== 'resolved' && event?.status !== 'closed') return;
    try {
      const conv: any = await this.conversationRepo.findById(
        event.conversationId,
      );
      const agentId = conv?.assignedAgentId;
      if (!agentId) return;

      const resolved = mergeRoutingConfig(
        await this.getRoutingConfig(event.tenantId),
      );
      const ttlSeconds = Math.max(
        60,
        Math.floor(resolved.stickyTimeoutHours * 3600),
      );
      const payload = JSON.stringify({
        agentId,
        resolvedAt: (
          conv.resolvedAt ??
          conv.updatedAt ??
          new Date()
        ).toString(),
      });

      const writes: Promise<unknown>[] = [];
      if (conv.contactId) {
        writes.push(
          this.redis.set(
            this.stickyContactKey(event.tenantId, String(conv.contactId)),
            payload,
            'EX',
            ttlSeconds,
          ),
        );
      }
      if (conv.externalSenderId) {
        writes.push(
          this.redis.set(
            this.stickySenderKey(event.tenantId, String(conv.externalSenderId)),
            payload,
            'EX',
            ttlSeconds,
          ),
        );
      }
      await Promise.all(writes);
    } catch (err: any) {
      // Non-fatal: sticky lookup falls back to MongoDB on a cache miss.
      this.logger.warn(
        `Failed to cache sticky agent for conversation ${event.conversationId}: ${err.message}`,
      );
    }
  }

  /** Read a cached sticky entry, or null on miss/parse error. */
  private async readStickyCache(
    key: string,
  ): Promise<{ agentId: string; resolvedAt: string } | null> {
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed?.agentId ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Invalidate the cached routing config for a tenant on EVERY API pod.
   * Drops this pod's entry immediately (fast self-heal) and publishes to the
   * Redis channel so other pods do the same. Pass no tenantId to flush all.
   */
  async invalidateRoutingConfig(tenantId?: string): Promise<void> {
    const payload = tenantId ?? '*';
    if (tenantId) {
      this.routingConfigCache.delete(tenantId);
    } else {
      this.routingConfigCache.clear();
    }
    try {
      await this.redis.publish(
        AssignmentService.CONFIG_INVALIDATION_CHANNEL,
        payload,
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to publish config invalidation for ${payload}: ${err.message}`,
      );
    }
  }

  /**
   * React to admin settings changes. Only omni_routing changes affect the
   * routing config cache. Fired in-process on the pod that served the PATCH;
   * invalidateRoutingConfig() fans it out to all pods via Redis pub/sub.
   */
  @OnEvent('settings.changed')
  async handleSettingsChanged(event: {
    key: string;
    tenantId?: string;
  }): Promise<void> {
    if (event?.key !== 'omni_routing') return;
    await this.invalidateRoutingConfig(event.tenantId);
  }

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
    const options: AssignmentOptions =
      typeof strategyOrOptions === 'string'
        ? { strategy: strategyOrOptions, agentPool }
        : (strategyOrOptions ?? {});

    // ── Resolve tenant routing config ─────────────────────────────────
    const routingConfig = await this.getRoutingConfig(tenantId);
    this.logger.debug(
      `assignConversation tenantId=${tenantId}, conversationId=${conversationId}`,
    );

    // ── Channel-first auto-assignment gate ─────────────────────────────
    const channelOverride = options.channelAutoAssignOverride;
    this.logger.debug(`channelOverride=${channelOverride ?? 'undefined'}`);

    const eligibilityResult = await this.checkAutoAssignEligibility(
      tenantId,
      conversationId,
      channelOverride,
      routingConfig,
    );
    if (eligibilityResult === 'queued') return null;

    // ── Evaluate routing rules ────────────────────────────────────────
    const ruleMatch = await this.resolveRoutingRuleMatch(tenantId, options);

    // ── Resolve effective routing config (channel ?? global ?? default) ──
    const resolved = mergeRoutingConfig(
      routingConfig,
      options.channelRoutingOverride,
    );

    const strategy: AssignmentStrategy = normalizeStrategy(
      ruleMatch?.strategy ?? options.strategy ?? resolved.defaultStrategy,
    );
    const tenantMaxCapacity: number = resolved.defaultMaxCapacity;
    const requiredSkills: string[] =
      ruleMatch?.requiredSkills ?? options.requiredSkills ?? [];

    // ── Resolve agent pool (routing rule team ∩ channel pool) ─────────
    const effectivePool = await this.resolveEffectivePool(
      ruleMatch,
      options.agentPool,
    );

    this.logger.debug(
      `Strategy resolved: ${strategy}, tenantMaxCapacity=${tenantMaxCapacity}, requiredSkills=[${requiredSkills.join(',')}], effectivePool size=${effectivePool?.length ?? 'all'}`,
    );

    // ── Get available agents ──────────────────────────────────────────
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
        reasonKey: 'noAgentsQueued',
        metadata: { poolSize: options.agentPool?.length ?? 0 },
        outcome: 'queued',
      });
      return null;
    }

    // ── Sticky routing ────────────────────────────────────────────────
    const stickyAgent = await this.tryStickyRoutingIfEnabled(
      tenantId,
      conversationId,
      availableAgents,
      options,
      resolved,
      tenantMaxCapacity,
      strategy,
    );
    if (stickyAgent === STICKY_WAITING_SENTINEL) return null;
    if (stickyAgent) return stickyAgent;

    // ── Filter by skills & run strategy ───────────────────────────────
    const eligibleAgents = await this.filterEligibleAgents(
      tenantId,
      availableAgents,
      requiredSkills,
      resolved.skillBasedRoutingEnabled,
    );

    const effectiveStrategy =
      strategy === 'sticky' ? resolved.fallbackStrategy : strategy;

    const metadata: Record<string, any> = {
      routingContext: options.routingContext ?? null,
      matchedRule: ruleMatch
        ? { ruleId: ruleMatch.ruleId, ruleName: ruleMatch.ruleName }
        : null,
    };

    const selection = await this.runStrategySelection(
      tenantId,
      conversationId,
      effectiveStrategy,
      eligibleAgents,
      tenantMaxCapacity,
      ruleMatch,
      metadata,
    );
    if (selection.earlyReturn) return null;

    const selectedAgent = await this.commitWithRollback(
      tenantId,
      conversationId,
      selection.selectedAgent,
      options,
    );

    await this.finalizeAssignment(
      tenantId,
      conversationId,
      selectedAgent,
      effectiveStrategy,
      selection.reason,
      selection.metadata,
      options,
    );

    return selectedAgent;
  }

  /**
   * Evaluate routing rules for the tenant, returning the matched rule or null.
   * Errors are caught and logged — fallback to default routing.
   */
  private async resolveRoutingRuleMatch(
    tenantId: string,
    options: AssignmentOptions,
  ): Promise<Awaited<
    ReturnType<RoutingRuleEvaluatorService['evaluateForTenant']>
  > | null> {
    if (!options.routingContext) {
      this.logger.debug(
        `No routingContext provided — skipping rule evaluation`,
      );
      return null;
    }

    this.logger.debug(`Evaluating routing rules for tenant ${tenantId}`);
    try {
      const match = await this.routingRuleEvaluator.evaluateForTenant(
        tenantId,
        options.routingContext,
      );
      this.logger.debug(
        `Routing rule matched: strategy=${match?.strategy ?? 'none'}, teamId=${match?.teamId ?? 'none'}`,
      );
      return match;
    } catch (err: any) {
      this.logger.warn(
        `Routing rule evaluation failed: ${err.message} — using default routing`,
      );
      return null;
    }
  }

  /**
   * Resolve the effective agent pool by intersecting the routing rule's
   * team members with the channel-scoped pool.
   */
  private async resolveEffectivePool(
    ruleMatch: { teamId?: string; ruleName?: string; strategy?: string } | null,
    channelPool: string[] | undefined,
  ): Promise<string[] | undefined> {
    if (!ruleMatch?.teamId) return channelPool;

    this.logger.debug(
      `Routing rule "${ruleMatch.ruleName}" matched — teamId=${ruleMatch.teamId}, strategy=${ruleMatch.strategy}`,
    );
    const teamMembers = await this.resolveGroupMembers(ruleMatch.teamId);
    if (teamMembers.length === 0) return channelPool;

    if (!channelPool || channelPool.length === 0) return teamMembers;

    // Intersect: only agents in BOTH channel pool AND routing rule team
    const teamSet = new Set(teamMembers);
    const intersected = channelPool.filter((id) => teamSet.has(id));
    this.logger.debug(
      `Team pool intersected with channel pool: ${intersected.length} agents eligible`,
    );
    return intersected;
  }

  /**
   * Attempt sticky routing if enabled and applicable.
   * Returns agent ID on success, STICKY_WAITING_SENTINEL if waiting,
   * or null to fall through to strategy-based assignment.
   */
  private async tryStickyRoutingIfEnabled(
    tenantId: string,
    conversationId: string,
    availableAgents: string[],
    options: AssignmentOptions,
    resolved: ResolvedRoutingConfig,
    tenantMaxCapacity: number,
    strategy: AssignmentStrategy,
  ): Promise<string | null> {
    const shouldTrySticky =
      !options.skipSticky &&
      resolved.stickyRoutingEnabled &&
      (strategy === 'sticky' || strategy !== 'manual');

    if (!shouldTrySticky) return null;

    const stickyResult = await this.tryStickyRouting(
      tenantId,
      conversationId,
      availableAgents,
      options,
      resolved,
      tenantMaxCapacity,
    );

    if (stickyResult === STICKY_WAITING_SENTINEL) {
      await this.writeAuditLog({
        tenantId,
        conversationId,
        assignedAgentId: null,
        strategy: 'sticky',
        reason: `Sticky wait-time: waiting for preferred agent (max ${resolved.stickyWaitTimeMinutes} min)`,
        reasonKey: 'stickyWait',
        reasonParams: { minutes: resolved.stickyWaitTimeMinutes },
        metadata: {
          stickyWaitTimeMinutes: resolved.stickyWaitTimeMinutes,
        },
        outcome: 'queued',
      });
      return STICKY_WAITING_SENTINEL;
    }

    return stickyResult;
  }

  /**
   * Filter agents by required skills with automatic fallback to the full
   * pool when no skilled agents are available.
   */
  private async filterEligibleAgents(
    tenantId: string,
    availableAgents: string[],
    requiredSkills: string[],
    skillBasedRoutingEnabled: boolean,
  ): Promise<string[]> {
    if (requiredSkills.length === 0 || !skillBasedRoutingEnabled) {
      return availableAgents;
    }

    const skilled = await this.filterBySkills(
      tenantId,
      availableAgents,
      requiredSkills,
    );

    if (skilled.length === 0) {
      this.logger.warn(
        `No agents with required skills ${requiredSkills.join(', ')} — falling back to full pool`,
      );
      return availableAgents;
    }

    return skilled;
  }

  /**
   * Determine whether auto-assignment should proceed based on the
   * channel-level override and the global toggle.
   *
   * Returns `'proceed'` when assignment should continue, or `'queued'` when
   * the conversation should be placed in the queue without assigning an agent.
   */
  private async checkAutoAssignEligibility(
    tenantId: string,
    conversationId: string,
    channelOverride: boolean | undefined,
    routingConfig: any,
  ): Promise<'proceed' | 'queued'> {
    if (channelOverride === true) {
      // Channel explicitly enabled — bypass global setting
      this.logger.debug(`Channel override=true → bypassing global toggle`);
      return 'proceed';
    }

    if (channelOverride !== undefined) {
      // channelOverride === false is handled upstream; any other truthy value proceeds
      return 'proceed';
    }

    // Channel did not set override — defer to global toggle
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
        reasonKey: 'autoAssignDisabled',
        metadata: { channelOverride: 'undefined', globalEnabled: false },
        outcome: 'queued',
      });
      return 'queued';
    }

    this.logger.debug(`Global auto-assign enabled → proceeding`);
    return 'proceed';
  }

  /** Run the strategy switch and return selection result. Returns earlyReturn=true for manual. */
  private async runStrategySelection(
    tenantId: string,
    conversationId: string,
    effectiveStrategy: AssignmentStrategy,
    eligibleAgents: string[],
    tenantMaxCapacity: number,
    ruleMatch: any,
    baseMeta: Record<string, any>,
  ): Promise<{
    earlyReturn: boolean;
    selectedAgent: string | null;
    reason: string;
    metadata: Record<string, any>;
  }> {
    let selectedAgent: string | null = null;
    let reason = '';
    let metadata = baseMeta;

    switch (effectiveStrategy) {
      case 'round-robin': {
        const ordered = await this.roundRobinOrder(
          tenantId,
          eligibleAgents,
          ruleMatch?.teamId,
        );
        selectedAgent = await this.reserveCandidate(
          tenantId,
          ordered,
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
        reason = selectedAgent
          ? `Capacity-based: reserved agent below capacity via Redis`
          : `All agents at max capacity — conversation queued`;
        metadata = { pool: eligibleAgents, tenantMaxCapacity };
        break;
      }
      case 'manual':
      default: {
        await this.writeAuditLog({
          tenantId,
          conversationId,
          assignedAgentId: null,
          strategy: 'manual',
          reason: 'Manual assignment — no auto-assign',
          reasonKey: 'manualAssignment',
          metadata,
          outcome: 'queued',
        });
        return { earlyReturn: true, selectedAgent: null, reason: '', metadata };
      }
    }
    return { earlyReturn: false, selectedAgent, reason, metadata };
  }

  /**
   * Commit the agent reservation to MongoDB with Redis rollback on failure.
   * Returns the committed agent ID, or null if rejected/rolled-back.
   */
  private async commitWithRollback(
    tenantId: string,
    conversationId: string,
    selectedAgent: string | null,
    options: AssignmentOptions,
  ): Promise<string | null> {
    if (!selectedAgent) return null;
    let committed: any;
    try {
      if (
        !options.allowReassignment &&
        typeof (this.conversationRepo as any).assignIfUnassigned === 'function'
      ) {
        committed = await this.conversationRepo.assignIfUnassigned(
          conversationId,
          selectedAgent,
        );
      } else {
        committed = await this.conversationRepo.updateAssignment(
          conversationId,
          selectedAgent,
        );
      }
    } catch (err: any) {
      this.logger.error(
        `MongoDB assignment write failed for conversation ${conversationId}: ${err.message} — rolling back`,
        err.stack,
      );
      await this.presenceService
        .releaseConversation?.(tenantId, selectedAgent)
        .catch(() => undefined);
      throw err;
    }
    if (committed === null) {
      this.logger.warn(
        `Rolled back Redis reservation for agent ${selectedAgent}: already assigned`,
      );
      await this.presenceService
        .releaseConversation?.(tenantId, selectedAgent)
        .catch((e: any) =>
          this.logger.error(
            `Failed to roll back reservation for ${selectedAgent}: ${e.message}`,
          ),
        );
      return null;
    }
    return selectedAgent;
  }

  /** Write audit log and emit queued event after strategy + commit resolution. */
  private async finalizeAssignment(
    tenantId: string,
    conversationId: string,
    selectedAgent: string | null,
    effectiveStrategy: AssignmentStrategy,
    reason: string,
    metadata: Record<string, any>,
    options: AssignmentOptions,
  ): Promise<void> {
    if (selectedAgent) {
      this.logger.log(
        `Auto-assigned ${conversationId} → agent ${selectedAgent} (${effectiveStrategy})`,
      );
      await this.writeAuditLog({
        tenantId,
        conversationId,
        assignedAgentId: selectedAgent,
        strategy: effectiveStrategy,
        reason,
        reasonKey: 'assigned',
        metadata,
        outcome: 'assigned',
      });
    } else {
      this.logger.warn(
        `No agent under ${effectiveStrategy} for ${conversationId} — queued`,
      );
      await this.writeAuditLog({
        tenantId,
        conversationId,
        assignedAgentId: null,
        strategy: effectiveStrategy,
        reason,
        reasonKey: 'noAgentsQueued',
        metadata,
        outcome: 'queued',
      });
      this.eventEmitter.emit(OmniEvents.CONVERSATION_QUEUED, {
        tenantId,
        conversationId,
        strategy: effectiveStrategy,
        reason,
        channelType: options.routingContext?.channel ?? 'unknown',
        queuedSince: new Date(),
        agentPoolSize: (metadata as any)?.pool?.length ?? 0,
      } satisfies ConversationQueuedEvent);
    }
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
    resolved: ResolvedRoutingConfig,
    tenantMaxCapacity: number,
  ): Promise<string | null> {
    const timeoutHours = resolved.stickyTimeoutHours;
    const withinTimeout: StickyTimeoutFn = (resolvedAt) => {
      if (!resolvedAt) return false;
      return (
        (Date.now() - new Date(resolvedAt).getTime()) / 3_600_000 <=
        timeoutHours
      );
    };

    let previousAgentId: string | null = null;
    let lookupSource = '';

    if (options.contactId) {
      const result = await this.lookupStickyContact(
        tenantId,
        options.contactId,
        withinTimeout,
      );
      previousAgentId = result.agentId;
      lookupSource = result.source;
    }

    if (!previousAgentId && options.externalSenderId) {
      const result = await this.lookupStickySender(
        tenantId,
        options.externalSenderId,
        withinTimeout,
      );
      previousAgentId = result.agentId;
      lookupSource = result.source;
    }

    if (!previousAgentId) return null;

    if (!availableAgents.includes(previousAgentId)) {
      this.logger.debug(
        `Sticky routing: previous agent ${previousAgentId} not available — falling back`,
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

    const reservedAgent = await this.presenceService.reserveAgentFromCandidates(
      tenantId,
      [previousAgentId],
    );

    if (!reservedAgent) {
      const stickyWaitMinutes = resolved.stickyWaitTimeMinutes;
      if (stickyWaitMinutes > 0) {
        this.logger.log(
          `Sticky: agent ${previousAgentId} at capacity (${openChats}/${agentCapacity}) — waiting ${stickyWaitMinutes} min`,
        );
        const scheduled = await this.scheduleStickyRetry(
          tenantId,
          conversationId,
          previousAgentId,
          resolved.fallbackStrategy,
          stickyWaitMinutes,
        );
        return scheduled ? STICKY_WAITING_SENTINEL : null;
      }
      this.logger.debug(
        `Sticky: agent ${previousAgentId} at capacity (${openChats}/${agentCapacity}) — falling back`,
      );
      return null;
    }

    return this.commitStickyAssignment(
      tenantId,
      conversationId,
      previousAgentId,
      options,
      openChats,
      agentCapacity,
      lookupSource,
    );
  }

  /** Schedule a BullMQ delayed retry for sticky routing. Returns true on success. */
  private async scheduleStickyRetry(
    tenantId: string,
    conversationId: string,
    stickyAgentId: string,
    fallbackStrategy: string,
    stickyWaitMinutes: number,
  ): Promise<boolean> {
    try {
      await this.stickyRetryQueue.add(
        'sticky-retry',
        { tenantId, conversationId, stickyAgentId, fallbackStrategy },
        {
          jobId: `sticky-retry-${conversationId}`,
          delay: stickyWaitMinutes * 60_000,
          removeOnComplete: true,
          removeOnFail: { count: 100 },
          attempts: 2,
          backoff: { type: 'fixed', delay: 5000 },
        },
      );
      return true;
    } catch (err: any) {
      this.logger.error(
        `Failed to schedule sticky retry for ${conversationId}: ${err.message}`,
      );
      return false;
    }
  }

  /** Commit the sticky assignment to DB and write the audit log. */
  private async commitStickyAssignment(
    tenantId: string,
    conversationId: string,
    previousAgentId: string,
    options: AssignmentOptions,
    openChats: number,
    agentCapacity: number,
    lookupSource: string,
  ): Promise<string | null> {
    let committed: any;
    if (
      !options.allowReassignment &&
      typeof (this.conversationRepo as any).assignIfUnassigned === 'function'
    ) {
      committed = await this.conversationRepo.assignIfUnassigned(
        conversationId,
        previousAgentId,
      );
    } else {
      committed = await this.conversationRepo.updateAssignment(
        conversationId,
        previousAgentId,
      );
    }

    if (committed === null) {
      await this.presenceService.releaseConversation?.(
        tenantId,
        previousAgentId,
      );
      return null;
    }

    this.logger.log(
      `Sticky-assigned ${conversationId} → agent ${previousAgentId} (lookup: ${lookupSource})`,
    );
    await this.writeAuditLog({
      tenantId,
      conversationId,
      assignedAgentId: previousAgentId,
      strategy: 'sticky',
      reason: `Sticky: re-assigned to previous agent (${lookupSource})`,
      reasonKey: 'stickyMatch',
      reasonParams: { agentId: previousAgentId, source: lookupSource },
      metadata: { openChats, agentCapacity, source: lookupSource },
      outcome: 'assigned',
    });
    return previousAgentId;
  }

  private async lookupStickyContact(
    tenantId: string,
    contactId: string,
    withinTimeout: StickyTimeoutFn,
  ): Promise<{ agentId: string | null; source: string }> {
    const cached = await this.readStickyCache(
      this.stickyContactKey(tenantId, contactId),
    );
    if (cached && withinTimeout(cached.resolvedAt))
      return { agentId: cached.agentId, source: 'contactId:cache' };
    const last = await this.conversationRepo.findLastResolvedByContact(
      tenantId,
      contactId,
    );
    if (
      last?.assignedAgentId &&
      withinTimeout(last.resolvedAt ?? last.updatedAt)
    ) {
      return { agentId: last.assignedAgentId, source: 'contactId' };
    }
    return { agentId: null, source: '' };
  }

  private async lookupStickySender(
    tenantId: string,
    senderId: string,
    withinTimeout: StickyTimeoutFn,
  ): Promise<{ agentId: string | null; source: string }> {
    const cached = await this.readStickyCache(
      this.stickySenderKey(tenantId, senderId),
    );
    if (cached && withinTimeout(cached.resolvedAt))
      return { agentId: cached.agentId, source: 'externalSenderId:cache' };
    const last = await this.conversationRepo.findLastResolvedBySender(
      tenantId,
      senderId,
    );
    if (
      last?.assignedAgentId &&
      withinTimeout(last.resolvedAt ?? last.updatedAt)
    ) {
      return { agentId: last.assignedAgentId, source: 'externalSenderId' };
    }
    return { agentId: null, source: '' };
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
    // ── Architecture note (F-07 fix) ──────────────────────────────────────
    // Previously this method used a duck-typing guard that called
    // `presenceService.reserveAgentFromCandidates` for ALL strategies,
    // meaning the same Lua script was executed regardless of the configured
    // strategy. The `least-busy` and `capacity-based` fallback branches below
    // were dead code that was never reached.
    //
    // Each strategy now has an explicit, correct implementation:
    //
    //   round-robin   → Iterate the pre-ordered list sequentially (respects
    //                   rotation); call the Lua script per-agent to atomically
    //                   reserve the first eligible one.
    //   least-busy    → Delegate to the Lua script which picks the ZSET
    //                   candidate with the lowest load score.
    //   capacity-based → Atomic Redis Lua reserve gated on effective capacity
    //                   (per-agent → tenant default). Increments the same load
    //                   counter as the other strategies (P1 data-integrity fix).
    // ─────────────────────────────────────────────────────────────────────

    if (agents.length === 0) return null;

    if (strategy === 'round-robin') {
      // Candidates are already ordered by roundRobinOrder(). P2 fix: a single
      // first-fit Lua reserve walks the rotated list and atomically reserves the
      // first eligible agent — replacing the previous N-round-trip loop (one EVAL
      // per candidate) WITHOUT collapsing rotation into least-busy.
      return this.presenceService.reserveFirstEligibleAgent(tenantId, agents);
    }

    if (strategy === 'capacity-based') {
      // P1 fix: atomic Redis reservation. Picks the lowest-load eligible agent
      // that is still under its effective capacity (per-agent → tenant default)
      // and increments the load counter in the same Lua call. This keeps the
      // load ZSET consistent with round-robin/least-busy and removes the
      // previous TOCTOU race + erroneous rollback decrement caused by the old
      // MongoDB-count path that returned an agent without reserving in Redis.
      return this.presenceService.reserveCapacityBasedAgent(
        tenantId,
        agents,
        tenantMaxCapacity,
      );
    }

    // Default: least-busy — Lua script picks the ZSET candidate with lowest load.
    return this.presenceService.reserveAgentFromCandidates(tenantId, agents);
  }

  /**
   * Round-robin: use a Redis counter to cycle through the agent pool.
   */
  private async roundRobinOrder(
    tenantId: string,
    agents: string[],
    teamId?: string,
  ): Promise<string[]> {
    // Per-team counter ensures fair distribution within each team pool.
    // Falls back to tenant-level counter when no team is specified.
    const key = teamId
      ? `omni:rr:${tenantId}:${teamId}`
      : `omni:rr:${tenantId}`;
    const counter = await this.redis.incr(key);
    // Set TTL on first creation (24h)
    if (counter === 1) {
      await this.redis.expire(key, 86400);
    }
    const index = (counter - 1) % agents.length;
    return [...agents.slice(index), ...agents.slice(0, index)];
  }

  // T11 fix: leastBusy() removed — dead code.
  // P1 fix: capacityBased() (MongoDB-count path) and resolveAgentCapacity()
  // removed — the capacity-based strategy now reserves atomically in Redis via
  // presenceService.reserveCapacityBasedAgent(), which resolves the effective
  // capacity (per-agent → tenant default → hardcoded) inside the Lua script.
  // The MongoDB count path returned an agent WITHOUT reserving, causing load
  // ZSET under-count, a TOCTOU race, and an erroneous rollback decrement.
  // (countOpenByAgents() remains in the repo — still used by
  // PresenceReconciliationService as the authoritative drift-correction source.)

  /**
   * Filter agents by required skills. An agent must have ALL required skills.
   *
   * P2 fix: resolves each agent's skills from the Redis presence cache (hydrated
   * at connect + synced on user update). Only agents whose skills are NOT cached
   * trigger a single batched MongoDB read, so the hot path is 0 DB reads once
   * presence is warm. Matching is case-insensitive.
   */
  private async filterBySkills(
    tenantId: string,
    agentIds: string[],
    requiredSkills: string[],
  ): Promise<string[]> {
    const skillMap = new Map<string, string[]>();
    const missing: string[] = [];

    // 1. Presence-first: read cached skills (cheap per-agent HGET, no Mongo).
    await Promise.all(
      agentIds.map(async (agentId) => {
        const presence = await this.presenceService.getPresence(
          tenantId,
          agentId,
        );
        if (presence?.skills !== undefined) {
          skillMap.set(agentId, presence.skills);
        } else {
          missing.push(agentId);
        }
      }),
    );

    // 2. Fallback: one batched Mongo read for any agent not hydrated in presence.
    if (missing.length > 0) {
      const users = await this.usersService.findByIds(missing);
      for (const user of users) {
        skillMap.set(user.id.toString(), user.skills ?? []);
      }
    }

    const needles = requiredSkills.map((s) => s.toLowerCase());
    return agentIds.filter((agentId) => {
      const agentSkills = (skillMap.get(agentId) ?? []).map((s) =>
        s.toLowerCase(),
      );
      return needles.every((skill) => agentSkills.includes(skill));
    });
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
   *
   * Cached per-tenant with a 5-minute TTL to avoid hitting DB on every
   * assignment call. Config is admin-edited (very rarely) vs read on every
   * inbound message.
   */
  private async getRoutingConfig(tenantId: string): Promise<any> {
    const now = Date.now();
    const cached = this.routingConfigCache.get(tenantId);

    if (cached && cached.expiresAt > now) {
      return cached.config;
    }

    try {
      const config = await this.settingsService.getSetting(
        'omni_routing',
        tenantId,
      );
      const result = config ?? {};
      this.routingConfigCache.set(tenantId, {
        config: result,
        expiresAt: now + this.CONFIG_CACHE_TTL_MS,
      });
      return result;
    } catch {
      return {};
    }
  }

  /**
   * T06: log a manual agent assignment (or unassignment) to the audit trail.
   *
   * Called by OmniController whenever an agent manually assigns or unassigns a
   * conversation via the REST API. These events were previously invisible in
   * the RoutingHistoryPage, creating a blind spot in the audit trail.
   *
   * @param params.conversationId - the conversation being (re)assigned
   * @param params.tenantId       - tenant context
   * @param params.newAgentId     - the agent being assigned (null = unassigned)
   * @param params.previousAgentId - the agent before this action (null = none)
   * @param params.performedByUserId - the agent or admin who triggered this
   * @param params.channelType    - channel type for per-channel analytics
   */
  async logManualAssignment(params: {
    conversationId: string;
    tenantId: string;
    newAgentId: string | null;
    previousAgentId: string | null;
    performedByUserId: string | null;
    channelType?: string | null;
  }): Promise<void> {
    const { newAgentId, previousAgentId, performedByUserId } = params;
    const verb = previousAgentId ? 'reassigned' : 'assigned';
    const actor = performedByUserId ?? 'unknown';
    const reason = newAgentId
      ? `Agent manually ${verb} by user ${actor}`
      : `Agent manually unassigned (back to queue) by user ${actor}`;

    const isReassign = !!previousAgentId;
    let reasonKey = 'manualUnassigned';
    if (newAgentId) {
      reasonKey = isReassign ? 'manualReassigned' : 'manualAssigned';
    }

    await this.writeAuditLog({
      tenantId: params.tenantId,
      conversationId: params.conversationId,
      assignedAgentId: newAgentId,
      previousAgentId: previousAgentId ?? null,
      strategy: 'manual',
      reason,
      reasonKey,
      reasonParams: { userId: performedByUserId ?? 'unknown' },
      channelType: params.channelType ?? null,
      metadata: { performedByUserId, isManual: true },
      outcome: newAgentId ? 'assigned' : 'queued',
    });
  }

  /**
   * Log an implicit assignment triggered by an agent replying to an
   * unassigned conversation. Separate from manual and auto-assignment so
   * the routing history page can distinguish the three sources.
   */
  async logReplyAutoAssignment(params: {
    conversationId: string;
    tenantId: string;
    agentId: string;
    channelType?: string | null;
  }): Promise<void> {
    await this.writeAuditLog({
      tenantId: params.tenantId,
      conversationId: params.conversationId,
      assignedAgentId: params.agentId,
      previousAgentId: null,
      strategy: 'reply_auto_assign',
      reason:
        'Agent replied to unassigned conversation — auto-assigned to replying agent',
      reasonKey: 'replyAutoAssign',
      channelType: params.channelType ?? null,
      metadata: { source: 'reply_auto_assign' },
      outcome: 'assigned',
    });
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
