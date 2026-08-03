import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import type Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { ConversationRepository } from '../repositories/conversation.repository';
import { OMNI_STICKY_RETRY_QUEUE } from '../queue/omni-sticky-queue.constants';
import type { StickyRetryJobData } from '../queue/sticky-retry.processor';
import { ConversationQueuedEvent, OmniEvents } from '../domain/omni-events';
import { ChannelSupportService } from '../../channels/services/channel-support.service';
import {
  AssignDecision,
  AssignRequest,
  AssignmentCoreService,
} from '../../assignment/core/assignment-core.service';
import {
  AssignmentConfigOverride,
  AssignmentConfigService,
} from '../../assignment/core/assignment-config.service';
import { AssignmentStrategy } from '../../assignment/domain/assignment.types';
import { normalizeStrategy } from '../../assignment/domain/assignment.types';
import { RoutingContext } from './routing-context.types';
import { ConversationAssignmentAdapter } from '../assignment/conversation-assignment.adapter';
import { ConversationCommitPort } from '../assignment/conversation-commit.port';
import { ConversationCandidatePort } from '../assignment/conversation-candidate.port';
import { RecordCandidatePort } from '../../assignment/adapters/record/record-candidate.port';
import { AgentPresenceService } from './agent-presence.service';
import { WorkDistributionService } from '../work-distribution/work-distribution.service';
import { resolveCapacityWeight } from '../work-distribution/capacity-policy';

/**
 * Per-channel routing override, stored on the channel as `channel.config.routing`.
 *
 * The field names are the channel-configuration vocabulary; `channelOverrideToConfigOverride()`
 * is the one place they are translated into the core's model.
 *
 * `stickyRoutingDefault` (renamed from `stickyRoutingEnabled`): this is an
 * ambient default, not an absolute kill switch — 'sticky' has not been a
 * selectable strategy since the assignment-core consolidation (see
 * `assignment.types.ts`), so there is no longer a code path where an
 * explicit strategy choice can bypass this setting. The old name implied a
 * hard toggle it never was.
 */
export interface ChannelRoutingOverride {
  defaultStrategy?: string;
  defaultMaxCapacity?: number;
  stickyRoutingDefault?: boolean;
  stickyTimeoutHours?: number;
  stickyWaitTimeMinutes?: number;
  stickyFallbackStrategy?: string;
  skillBasedRoutingEnabled?: boolean;
  skillFallbackMode?: 'strict' | 'lenient';
}

/**
 * Translate a channel's override into the core's vocabulary.
 *
 * Undefined fields stay undefined so they inherit — per-field, not per-object.
 * A channel that overrides only the strategy must keep inheriting the other
 * settings, which is why this cannot be a spread of a defaulted object.
 */
export function channelOverrideToConfigOverride(
  override?: ChannelRoutingOverride | null,
): AssignmentConfigOverride | null {
  if (!override) return null;
  const result: AssignmentConfigOverride = {};
  if (override.defaultStrategy !== undefined) {
    result.defaultStrategy = normalizeStrategy(override.defaultStrategy);
  }
  if (override.defaultMaxCapacity !== undefined) {
    result.defaultMaxCapacity = override.defaultMaxCapacity;
  }
  if (override.stickyRoutingDefault !== undefined) {
    result.preferPreviousAssignee = override.stickyRoutingDefault;
  }
  if (override.stickyTimeoutHours !== undefined) {
    result.previousAssigneeTimeoutHours = override.stickyTimeoutHours;
  }
  if (override.stickyWaitTimeMinutes !== undefined) {
    result.previousAssigneeWaitMinutes = override.stickyWaitTimeMinutes;
  }
  if (override.stickyFallbackStrategy !== undefined) {
    result.stickyFallbackStrategy = normalizeStrategy(
      override.stickyFallbackStrategy,
    );
  }
  if (override.skillBasedRoutingEnabled !== undefined) {
    result.skillBasedRoutingEnabled = override.skillBasedRoutingEnabled;
  }
  if (override.skillFallbackMode !== undefined) {
    result.skillFallbackMode = override.skillFallbackMode;
  }
  return result;
}

export interface AssignmentOptions {
  /** Force a strategy, overriding rule and settings. */
  strategy?: AssignmentStrategy | string;
  /** Extra hard restriction on top of the channel support pool. */
  agentPool?: string[];
  /** Agents to skip on this pass only — e.g. one who just let an offer lapse. */
  excludeAgentIds?: string[];
  contactId?: string | null;
  externalSenderId?: string | null;
  requiredSkills?: string[];
  /** Do not attempt the preferred-assignee lookup (used by the retry path). */
  skipSticky?: boolean;
  routingContext?: RoutingContext;
  /**
   * Channel-level auto-assignment override.
   *   true      → the channel enabled it explicitly, ignoring the global toggle
   *   false     → handled upstream; should not reach here
   *   undefined → defer to the objectType setting
   */
  channelAutoAssignOverride?: boolean;
  channelRoutingOverride?: ChannelRoutingOverride;
  /** Allow replacing an agent who is already assigned. */
  allowReassignment?: boolean;
  /**
   * The agent the caller observed as currently assigned, when
   * `allowReassignment` is set. The reassignment commit is a compare-and-swap
   * against this value — `null` for "must still be unassigned" — so a second,
   * concurrent reassignment decision loses cleanly instead of both winning.
   */
  expectedPreviousAgentId?: string | null;
  /** Team that owns the conversation when no rule names one. */
  owningGroupId?: string | null;
  channelId?: string | null;
  /** Audit provenance. */
  source?: AssignRequest['source'];
  sourceWorkflowId?: string | null;
}

/**
 * Conversation assignment.
 *
 * All routing logic — rules, target chain, capacity, skills, reservation,
 * rollback, fallback, audit — lives in AssignmentCoreService. What stays here is
 * everything that is genuinely specific to a conversation:
 *
 *   - the preferred-assignee ("sticky") *lookup*: who last handled this customer
 *   - scheduling the delayed retry when that person is busy
 *   - the queued event the inbox listens for
 *   - manual/reply assignment audit entries
 *
 * The service used to be 1807 lines and contained a second complete copy of the
 * decision pipeline.
 */
@Injectable()
export class AssignmentService implements OnModuleInit {
  private readonly logger = new Logger(AssignmentService.name);

  constructor(
    private readonly core: AssignmentCoreService,
    private readonly config: AssignmentConfigService,
    private readonly adapter: ConversationAssignmentAdapter,
    private readonly commitPort: ConversationCommitPort,
    private readonly candidatePort: ConversationCandidatePort,
    private readonly recordCandidatePort: RecordCandidatePort,
    private readonly presenceService: AgentPresenceService,
    private readonly conversationRepo: ConversationRepository,
    private readonly channelSupportService: ChannelSupportService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(OMNI_STICKY_RETRY_QUEUE)
    private readonly stickyRetryQueue: Queue<StickyRetryJobData>,
    private readonly workDistribution: WorkDistributionService,
  ) {}

  /**
   * Register the conversation adapter with the core.
   *
   * Done at init rather than through DI multi-injection because the core module
   * must not depend on this one: omni-inbound owns queues and imports the
   * channel graph, and a static edge would put all of it inside the core's
   * dependency cycle.
   */
  onModuleInit(): void {
    this.core.registerAdapter(this.adapter);
    // The record adapter needs presence for its availability filter but must not
    // depend on this module. Handing it the one live instance here keeps a
    // single AgentPresenceService in the process.
    this.recordCandidatePort.setPresenceProvider(this.presenceService);
  }

  // Preferred-assignee ("sticky") cache

  private stickyContactKey(tenantId: string, contactId: string): string {
    return `omni:sticky:${tenantId}:c:${contactId}`;
  }

  private stickySenderKey(tenantId: string, senderId: string): string {
    return `omni:sticky:${tenantId}:s:${senderId}`;
  }

  /**
   * On resolve/close, remember who handled this customer so the next inbound
   * message can look them up in Redis instead of querying MongoDB.
   *
   * The TTL is exactly the configured timeout, so the key self-expires at the
   * moment the preference would no longer apply — no separate staleness check
   * is needed on read beyond the one that guards the MongoDB fallback.
   */
  @OnEvent('omni.conversation.status_changed')
  async handleConversationResolvedForSticky(event: {
    tenantId: string;
    conversationId: string;
    status: string;
  }): Promise<void> {
    if (event?.status !== 'resolved' && event?.status !== 'closed') return;
    try {
      const conversation: any = await this.conversationRepo.findById(
        event.conversationId,
      );
      const agentId = conversation?.assignedAgentId;
      if (!agentId) return;

      const config = await this.config.get(event.tenantId, 'Conversation');
      const ttlSeconds = Math.max(
        60,
        Math.floor(config.previousAssigneeTimeoutHours * 3600),
      );
      const payload = JSON.stringify({
        agentId: String(agentId),
        resolvedAt: new Date(
          conversation.resolvedAt ?? conversation.updatedAt ?? Date.now(),
        ).toISOString(),
      });

      const writes: Promise<unknown>[] = [];
      if (conversation.contactId) {
        writes.push(
          this.redis.set(
            this.stickyContactKey(
              event.tenantId,
              String(conversation.contactId),
            ),
            payload,
            'EX',
            ttlSeconds,
          ),
        );
      }
      if (conversation.externalSenderId) {
        writes.push(
          this.redis.set(
            this.stickySenderKey(
              event.tenantId,
              String(conversation.externalSenderId),
            ),
            payload,
            'EX',
            ttlSeconds,
          ),
        );
      }
      await Promise.all(writes);
    } catch (err: any) {
      // Non-fatal: a cache miss falls back to MongoDB.
      this.logger.warn(
        `Failed to cache the preferred agent for conversation ${event.conversationId}: ${err.message}`,
      );
    }
  }

  /**
   * Drop the cached assignment config for a tenant on every pod.
   *
   * `omni_routing` still holds presence-facing settings (`autoAvailableOnConnect`),
   * so a change to it can legitimately arrive without touching assignment — the
   * invalidation is cheap and unconditional rather than trying to diff.
   */
  @OnEvent('settings.changed')
  async handleSettingsChanged(event: {
    key: string;
    tenantId?: string;
  }): Promise<void> {
    if (event?.key !== 'omni_routing') return;
    await this.config.invalidate(event.tenantId, 'Conversation');
  }

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
   * Who last handled this customer, if that was recent enough to still count.
   *
   * Contact id first, then the channel-specific sender id: a resolved contact is
   * the stronger identity, and falling back to the sender covers conversations
   * whose contact has not been resolved yet.
   */
  private async lookupPreferredAgent(
    tenantId: string,
    options: AssignmentOptions,
    timeoutHours: number,
  ): Promise<{ assigneeId: string; source: string } | null> {
    const withinTimeout = (at: string | Date | undefined | null): boolean => {
      if (!at) return false;
      const ms = new Date(at).getTime();
      if (Number.isNaN(ms)) return false;
      return (Date.now() - ms) / 3_600_000 <= timeoutHours;
    };

    if (options.contactId) {
      const cached = await this.readStickyCache(
        this.stickyContactKey(tenantId, options.contactId),
      );
      if (cached && withinTimeout(cached.resolvedAt)) {
        return { assigneeId: cached.agentId, source: 'contactId:cache' };
      }
      const last = await this.conversationRepo.findLastResolvedByContact(
        tenantId,
        options.contactId,
      );
      if (
        last?.assignedAgentId &&
        withinTimeout(last.resolvedAt ?? last.updatedAt)
      ) {
        return {
          assigneeId: String(last.assignedAgentId),
          source: 'contactId',
        };
      }
    }

    if (options.externalSenderId) {
      const cached = await this.readStickyCache(
        this.stickySenderKey(tenantId, options.externalSenderId),
      );
      if (cached && withinTimeout(cached.resolvedAt)) {
        return { assigneeId: cached.agentId, source: 'externalSenderId:cache' };
      }
      const last = await this.conversationRepo.findLastResolvedBySender(
        tenantId,
        options.externalSenderId,
      );
      if (
        last?.assignedAgentId &&
        withinTimeout(last.resolvedAt ?? last.updatedAt)
      ) {
        return {
          assigneeId: String(last.assignedAgentId),
          source: 'externalSenderId',
        };
      }
    }

    return null;
  }

  // Auto-assignment

  /**
   * Auto-assign a conversation. Returns the assigned agent id, or null when the
   * conversation was queued or deferred.
   */
  async assignConversation(
    tenantId: string,
    conversationId: string,
    strategyOrOptions?: AssignmentStrategy | string | AssignmentOptions,
    agentPool?: string[],
  ): Promise<string | null> {
    const options: AssignmentOptions =
      typeof strategyOrOptions === 'string'
        ? { strategy: strategyOrOptions, agentPool }
        : (strategyOrOptions ?? {});

    const configOverride = channelOverrideToConfigOverride(
      options.channelRoutingOverride,
    );

    // A channel that explicitly enabled auto-assignment overrides the
    // objectType toggle. `false` is handled before we are called.
    const effectiveOverride: AssignmentConfigOverride | null =
      options.channelAutoAssignOverride === true
        ? { ...(configOverride ?? {}), autoAssignEnabled: true }
        : configOverride;

    const config = await this.config.resolve(
      tenantId,
      'Conversation',
      effectiveOverride,
    );

    // The preferred-assignee lookup happens here because it is conversation
    // knowledge; what the core does with the result is generic.
    let preferred: AssignRequest['preferred'] = null;
    if (!options.skipSticky && config.preferPreviousAssignee) {
      const found = await this.lookupPreferredAgent(
        tenantId,
        options,
        config.previousAssigneeTimeoutHours,
      );
      // The excluded agent is usually also the sticky one — they handled this
      // customer last, which is why they were offered the work they just let
      // lapse. Honouring stickiness here would re-offer it straight back.
      if (found && !options.excludeAgentIds?.includes(found.assigneeId)) {
        preferred = {
          assigneeId: found.assigneeId,
          source: found.source,
          onBusy:
            config.previousAssigneeWaitMinutes > 0 ? 'wait' : 'fall-through',
        };
      }
    }

    const request: AssignRequest = {
      tenantId,
      objectType: 'Conversation',
      entityId: conversationId,
      scopeId: options.channelId ?? null,
      attributes: this.toAttributes(options.routingContext),
      strategy: options.strategy
        ? normalizeStrategy(String(options.strategy))
        : null,
      requiredSkills: options.requiredSkills ?? [],
      owningGroupId: options.owningGroupId ?? null,
      restrictToCandidates: options.agentPool ?? null,
      excludeCandidates: options.excludeAgentIds ?? null,
      preferred,
      configOverride: effectiveOverride,
      previousAssigneeId: options.allowReassignment
        ? (options.expectedPreviousAgentId ?? null)
        : undefined,
      // An explicit reassignment is a compare-and-swap against the agent the
      // caller observed before deciding to reassign; the default is a
      // conditional claim (against "still unassigned") that loses the race
      // rather than stealing work.
      commit: options.allowReassignment
        ? (assigneeId, groupId) =>
            this.commitPort.reassign(
              {
                tenantId,
                objectType: 'Conversation',
                entityId: conversationId,
                scopeId: options.channelId ?? null,
              },
              assigneeId,
              groupId,
              options.expectedPreviousAgentId ?? null,
            )
        : (assigneeId, groupId) =>
            this.workDistribution.createOfferFromReservation({
              tenantId,
              conversationId,
              agentId: assigneeId,
              groupId,
            }),
      commitOutcome: options.allowReassignment ? 'assigned' : 'offered',
      source: options.source ?? 'inbound',
      sourceWorkflowId: options.sourceWorkflowId ?? null,
      channelType: options.routingContext?.channel ?? null,
      metadata: {
        routingContext: options.routingContext ?? null,
      },
    };

    const decision = await this.core.assign(request);
    await this.afterDecision(tenantId, conversationId, decision, options);
    return decision.outcome === 'assigned' ? decision.assigneeId : null;
  }

  /**
   * React to the outcome: schedule the sticky retry, or tell the inbox a
   * conversation is waiting in a queue.
   */
  private async afterDecision(
    tenantId: string,
    conversationId: string,
    decision: AssignDecision,
    options: AssignmentOptions,
  ): Promise<void> {
    if (decision.outcome === 'deferred' && decision.deferred) {
      await this.scheduleStickyRetry(
        tenantId,
        conversationId,
        decision.deferred.assigneeId,
        decision.deferred.waitMinutes,
      );
      return;
    }

    if (decision.outcome === 'queued') {
      this.eventEmitter.emit(OmniEvents.CONVERSATION_QUEUED, {
        tenantId,
        conversationId,
        strategy: decision.strategy,
        reason: decision.reason,
        channelType: options.routingContext?.channel ?? 'unknown',
        queuedSince: new Date(),
        agentPoolSize: decision.candidatePoolSize,
      } satisfies ConversationQueuedEvent);
    }
  }

  /**
   * Hold the conversation for a busy preferred agent, then retry without the
   * preference.
   *
   * `jobId` is derived from the conversation so a second inbound message cannot
   * queue a second retry for the same conversation.
   */
  private async scheduleStickyRetry(
    tenantId: string,
    conversationId: string,
    stickyAgentId: string,
    waitMinutes: number,
  ): Promise<void> {
    try {
      await this.stickyRetryQueue.add(
        'sticky-retry',
        { tenantId, conversationId, stickyAgentId, fallbackStrategy: '' },
        {
          jobId: `sticky-retry-${conversationId}`,
          delay: waitMinutes * 60_000,
          removeOnComplete: true,
          removeOnFail: { count: 100 },
          attempts: 2,
          backoff: { type: 'fixed', delay: 5000 },
        },
      );
    } catch (err: any) {
      // The conversation is already audited as deferred and sits in the queue,
      // so a failed schedule degrades to "waits for a human" rather than
      // vanishing.
      this.logger.error(
        `Failed to schedule the preferred-agent retry for ${conversationId}: ${err.message}`,
      );
    }
  }

  /**
   * Flatten the routing context into the attribute bag the evaluator reads.
   *
   * The keys are the rule-condition field names, so the evaluator does a plain
   * lookup. The old evaluator resolved them through a `switch (field)`, which
   * meant a new routing field required editing the evaluator and an unknown
   * field silently never matched.
   */
  private toAttributes(
    context?: RoutingContext,
  ): Record<string, unknown> | undefined {
    if (!context) return undefined;
    return {
      channel: context.channel,
      channel_id: context.channelId,
      tag: context.tags,
      customer_name: context.customerName,
      content: context.content,
      time: context.time,
      segment: context.segment,
      business_hours: context.businessHours,
      org_unit: context.orgUnitId,
      language: context.language,
      capacityWeight: resolveCapacityWeight(context.channel ?? 'unknown'),
    };
  }

  // External (automation / API) assignment

  /**
   * Assign on behalf of something other than the inbound pipeline — today, an
   * automation action.
   *
   * Exists so automation does not reach for the generic CRM `ownerId` path:
   * conversations have `assignedAgentId` + `assignedGroupId`, assignment has to
   * move the presence capacity counters, and the channel's support pool applies.
   * A plain field write would produce an assignment the presence and capacity
   * layers never heard about.
   *
   * Exactly one of `agentId` / `groupId` drives the outcome.
   */
  async assignConversationExternally(
    tenantId: string,
    conversationId: string,
    target: { agentId?: string | null; groupId?: string | null },
    source: string,
  ): Promise<{ agentId: string | null; groupId: string | null }> {
    const conversation: any =
      await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }
    const channelId = conversation.channelId
      ? String(conversation.channelId)
      : null;

    if (target.agentId) {
      // The caller named the person, so there is no strategy to run — but the
      // channel's support pool still decides whether they may serve it.
      await this.channelSupportService.assertAgentEligible(
        tenantId,
        channelId,
        target.agentId,
      );

      const groupId =
        target.groupId ??
        (conversation.assignedGroupId
          ? String(conversation.assignedGroupId)
          : null);
      const previousAgentId = conversation.assignedAgentId
        ? String(conversation.assignedAgentId)
        : null;

      const decision = await this.core.assign({
        tenantId,
        objectType: 'Conversation',
        entityId: conversationId,
        scopeId: channelId,
        manualAssigneeId: target.agentId,
        owningGroupId: groupId,
        previousAssigneeId: previousAgentId,
        commit: (assigneeId, gid) =>
          this.commitPort.reassign(
            {
              tenantId,
              objectType: 'Conversation',
              entityId: conversationId,
              scopeId: channelId,
            },
            assigneeId,
            gid,
            previousAgentId,
          ),
        source: 'automation',
        sourceWorkflowId: source,
        metadata: { externalSource: source, previousAgentId },
      });

      // Hand the previous agent's capacity slot back. The new slot was reserved
      // by the core; without this the old agent stays counted as busy.
      if (previousAgentId && previousAgentId !== target.agentId) {
        await this.adapter.load
          .release(
            { tenantId, objectType: 'Conversation', entityId: conversationId },
            previousAgentId,
          )
          .catch((err: any) =>
            this.logger.warn(
              `Failed to release the previous agent's slot (${previousAgentId}): ${err.message}`,
            ),
          );
      }

      return { agentId: decision.assigneeId, groupId };
    }

    if (!target.groupId) {
      throw new Error(
        'assignConversationExternally requires agentId or groupId',
      );
    }

    await this.channelSupportService.assertGroupEligible(
      tenantId,
      channelId,
      target.groupId,
    );

    const previousAgentIdForGroup = conversation.assignedAgentId
      ? String(conversation.assignedAgentId)
      : null;

    // The caller chose the team explicitly, so rules are skipped: re-running
    // them could override that choice with a different team.
    const decision = await this.core.assign({
      tenantId,
      objectType: 'Conversation',
      entityId: conversationId,
      scopeId: channelId,
      targetGroupIds: [target.groupId],
      owningGroupId: target.groupId,
      skipRules: true,
      previousAssigneeId: previousAgentIdForGroup,
      commit: (assigneeId, gid) =>
        this.commitPort.reassign(
          {
            tenantId,
            objectType: 'Conversation',
            entityId: conversationId,
            scopeId: channelId,
          },
          assigneeId,
          gid,
          previousAgentIdForGroup,
        ),
      source: 'automation',
      sourceWorkflowId: source,
      metadata: { externalSource: source },
    });

    await this.afterDecision(tenantId, conversationId, decision, {});

    return { agentId: decision.assigneeId, groupId: target.groupId };
  }

  // Audit for decisions the core did not make

  /**
   * Record a manual (re)assignment or unassignment made through the REST API.
   *
   * These go in the same trail as automatic decisions so the history page shows
   * one timeline. They were previously invisible there.
   */
  async logManualAssignment(params: {
    conversationId: string;
    tenantId: string;
    /** `undefined` means the agent field was not touched — a group-only change. */
    newAgentId?: string | null;
    previousAgentId: string | null;
    performedByUserId: string | null;
    channelType?: string | null;
    groupId?: string | null;
  }): Promise<void> {
    const { previousAgentId, performedByUserId } = params;
    const newAgentId = params.newAgentId ?? null;
    const actor = performedByUserId ?? 'unknown';

    if (params.newAgentId === undefined) {
      // Group-only change: the agent was not touched, so 'reassigned'/
      // 'unassigned' language would misdescribe what actually happened.
      await this.core.recordExternalDecision({
        tenantId: params.tenantId,
        objectType: 'Conversation',
        entityId: params.conversationId,
        assigneeId: null,
        previousAssigneeId: null,
        groupId: params.groupId ?? null,
        strategy: 'manual',
        outcome: 'queued',
        reason: `Group reassigned by user ${actor}`,
        reasonKey: 'manualGroupReassigned',
        reasonParams: { userId: actor },
        source: 'manual',
        performedByUserId,
        channelType: params.channelType ?? null,
      });
      return;
    }

    const verb = previousAgentId ? 'reassigned' : 'assigned';

    let reasonKey: 'manualAssigned' | 'manualReassigned' | 'manualUnassigned' =
      'manualUnassigned';
    if (newAgentId) {
      reasonKey = previousAgentId ? 'manualReassigned' : 'manualAssigned';
    }

    await this.core.recordExternalDecision({
      tenantId: params.tenantId,
      objectType: 'Conversation',
      entityId: params.conversationId,
      assigneeId: newAgentId,
      previousAssigneeId: previousAgentId,
      groupId: params.groupId ?? null,
      strategy: 'manual',
      outcome: newAgentId ? 'assigned' : 'queued',
      reason: newAgentId
        ? `Agent manually ${verb} by user ${actor}`
        : `Agent manually unassigned (back to queue) by user ${actor}`,
      reasonKey,
      reasonParams: { userId: actor },
      source: 'manual',
      performedByUserId: performedByUserId ?? null,
      channelType: params.channelType ?? null,
      metadata: { isManual: true },
    });
  }

  /**
   * Record the implicit assignment that happens when an agent replies to an
   * unassigned conversation. Separate from manual and automatic so the history
   * page can tell the three apart.
   */
  async logReplyAutoAssignment(params: {
    conversationId: string;
    tenantId: string;
    agentId: string;
    channelType?: string | null;
  }): Promise<void> {
    await this.core.recordExternalDecision({
      tenantId: params.tenantId,
      objectType: 'Conversation',
      entityId: params.conversationId,
      assigneeId: params.agentId,
      strategy: 'reply_auto_assign',
      outcome: 'assigned',
      reason:
        'Agent replied to an unassigned conversation — auto-assigned to the replying agent',
      reasonKey: 'replyAutoAssign',
      source: 'reply',
      channelType: params.channelType ?? null,
      metadata: { source: 'reply_auto_assign' },
    });
  }

  // Helpers still used by callers outside this service

  /** Members of one or more teams, deduplicated. */
  async resolveGroupMembers(
    groupIdOrIds: string | string[],
  ): Promise<string[]> {
    const ids = Array.isArray(groupIdOrIds) ? groupIdOrIds : [groupIdOrIds];
    if (ids.length === 0) return [];
    return this.candidatePort.groupMembers(
      { tenantId: '', objectType: 'Conversation' },
      ids,
    );
  }
}
