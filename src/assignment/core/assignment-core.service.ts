import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  ASSIGNMENT_ADAPTER,
  AssignmentAdapter,
  AssignmentScope,
} from './ports';
import {
  AssignmentConfigOverride,
  AssignmentConfigService,
  ResolvedAssignmentConfig,
} from './assignment-config.service';
import { AssignmentRuleEvaluatorService } from './rule-evaluator.service';
import {
  AssignmentAuditLogRepository,
  WriteAuditEntry,
} from '../infrastructure/persistence/assignment-audit-log.repository';
import {
  AssignmentObjectType,
  AssignmentOutcome,
  AssignmentReasonKey,
  AssignmentSource,
  AssignmentStrategy,
} from '../domain/assignment.types';
import { RuleMatch } from '../domain/assignment-rule';
import { AssignmentAttributes, RuleTrace } from '../domain/condition-evaluator';
import { AssignmentPolicyVersionService } from '../application/assignment-policy-version.service';
import { AssignmentStrategyRegistry } from './assignment-strategy.registry';

// ── Request / response ─────────────────────────────────────────────────────

/**
 * A preferred assignee — "sticky". The lookup that produces the id is
 * domain-specific (omni looks up who last handled this customer) and stays in
 * the adapter; what the core owns is what happens when the preferred person is
 * available, busy, or not in the pool.
 */
export interface PreferredAssignee {
  assigneeId: string;
  /**
   * `wait` → when the preferred assignee is at capacity, return `deferred` and
   * let the caller schedule a retry. `fall-through` → carry on to the strategy.
   */
  onBusy: 'wait' | 'fall-through';
  /** For the audit trail: where the id came from ('contactId', 'cache', ...). */
  source?: string;
}

export interface AssignRequest {
  tenantId: string;
  objectType: AssignmentObjectType;
  /** Absent for a pre-create or dry-run decision. */
  entityId?: string;
  commandId?: string | null;
  /** Narrower settings/rotation scope — the omni channel id today. */
  scopeId?: string | null;
  /** Bag the rule conditions are matched against. */
  attributes?: AssignmentAttributes;

  /** Skip everything and use this assignee. Still audited. */
  manualAssigneeId?: string | null;
  /**
   * The assignee the caller observed before this decision, for reassignments.
   * Recorded verbatim on the audit entry — `finish()` no longer hardcodes
   * `null` — so `{tenantId, previousAssigneeId, createdAt}` stays a reliable
   * index for core-driven reassignments, not just the manual external-decision
   * path.
   */
  previousAssigneeId?: string | null;
  /** Skip assignment entirely — the caller has already decided not to. */
  bypass?: boolean;

  /**
   * Force a strategy, overriding both the matched rule and the settings. Used
   * by retry/fallback paths that must not re-run the sticky preference.
   */
  strategy?: AssignmentStrategy | null;
  /** Force the target team, overriding rule evaluation entirely. */
  targetGroupIds?: string[] | null;
  /** Force one assignee subject to the normal eligibility checks. */
  targetUserId?: string | null;
  /** Additional required skills, merged with the matched rule's. */
  requiredSkills?: string[];
  /** Group that owns the record when no rule and no target names one. */
  owningGroupId?: string | null;
  /**
   * Extra hard restriction on top of the adapter's base pool — a caller that has
   * already resolved a narrower set of candidates.
   *
   * `[]` means "nobody", never "no restriction". That distinction is load-bearing:
   * treating an empty resolved pool as unrestricted is how a channel with a
   * locked-down support list ended up routed over the entire tenant.
   */
  restrictToCandidates?: string[] | null;

  preferred?: PreferredAssignee | null;
  /** Skip rule evaluation — the caller has already chosen the target. */
  skipRules?: boolean;
  /** Per-scope config override, merged per-field over the stored settings. */
  configOverride?: AssignmentConfigOverride | null;

  /**
   * Replace the adapter's commit for this call.
   *
   * Automation must write `ownerId` through the CRM update service so
   * field-level authorisation, activity logging and automation breadcrumbs
   * still apply; it cannot bypass that with a raw `$set`. Passing the commit in
   * keeps that requirement satisfied while leaving reserve/release inside the
   * core, so the reservation can never leak — which is exactly what went wrong
   * when callers were expected to call a public `compensate()` themselves.
   *
   * Returns false to signal "lost the race", same contract as CommitPort.
   */
  commit?: (assigneeId: string, groupId: string | null) => Promise<boolean>;
  /**
   * Meaning of a successful custom commit. Conversation auto-routing uses an
   * offer commit; record assignment and manual operations remain immediate.
   */
  commitOutcome?: 'assigned' | 'offered';

  /** Do not persist, do not reserve, do not audit. */
  dryRun?: boolean;
  /** Collect a full rule-by-rule trace (dry run / explain). */
  explain?: boolean;

  source?: AssignmentSource;
  sourceWorkflowId?: string | null;
  performedByUserId?: string | null;
  /** Conversation channel type, for per-channel audit analytics. */
  channelType?: string | null;
  /** Extra audit metadata. */
  metadata?: Record<string, any>;
}

export interface AssignDecision {
  outcome: AssignmentOutcome;
  assigneeId: string | null;
  /** Team the record is filed under — set even when there is no assignee. */
  groupId: string | null;
  strategy: string;
  reasonKey: AssignmentReasonKey;
  reason: string;
  reasonParams?: Record<string, any> | null;
  rule: { id: string; name: string } | null;
  candidatePoolSize: number;
  eligiblePoolSize: number;
  policyVersionId?: string | null;
  /** Present when `outcome === 'deferred'` — who to wait for and for how long. */
  deferred?: { assigneeId: string; waitMinutes: number };
  /** Present when `explain` was requested. */
  traces?: RuleTrace[];
}

/**
 * Sentinel for "a rule named teams, and none of them may serve this scope".
 * Distinct from an empty pool: there is no group to queue under either, and the
 * misconfiguration is worth its own audit reason.
 */
const UNROUTABLE = Symbol('unroutable');

interface Target {
  candidates: string[];
  owningGroupId: string | null;
  /** Poolsize before capacity/skill filtering, for the audit trail. */
  poolSize: number;
}

/** Ordered intersection, preserving `a`'s order. */
function intersect(a: string[], b: string[]): string[] {
  const set = new Set(b.map(String));
  return a.filter((id) => set.has(String(id)));
}

/**
 * The single assignment decision pipeline, for every objectType.
 *
 * Order of operations:
 *   0. bypass / manual override
 *   1. resolve config (settings ⊕ scope override) and gate on autoAssignEnabled
 *   2. evaluate rules → matched rule (or a caller-forced target)
 *   3. resolve the target: pinned user, or the rule's ordered team chain,
 *      hard-intersected with the adapter's base pool at every step
 *   4. filter by skills
 *   5. honour the preferred assignee, if any
 *   6. reserve one candidate atomically via LoadPort
 *   7. commit; on failure or a lost race, release the reservation
 *   8. fall back to the configured owner, else queue under the owning group
 *   9. audit
 *
 * Steps 6–7 are wrapped so that every exit path from a successful reservation
 * either commits or releases. That invariant is why there is no public
 * `compensate()`: no caller is in a position to forget it.
 */
@Injectable()
export class AssignmentCoreService {
  private readonly logger = new Logger(AssignmentCoreService.name);

  private readonly adapters = new Map<
    AssignmentObjectType,
    AssignmentAdapter
  >();

  constructor(
    private readonly config: AssignmentConfigService,
    private readonly ruleEvaluator: AssignmentRuleEvaluatorService,
    private readonly audit: AssignmentAuditLogRepository,
    @Optional()
    @Inject(ASSIGNMENT_ADAPTER)
    adapters: AssignmentAdapter[] | AssignmentAdapter | null,
    @Optional()
    private readonly policyVersions?: AssignmentPolicyVersionService,
    @Optional()
    private readonly strategies?: AssignmentStrategyRegistry,
  ) {
    const list = Array.isArray(adapters)
      ? adapters
      : adapters
        ? [adapters]
        : [];
    for (const adapter of list) {
      for (const objectType of adapter.objectTypes) {
        this.adapters.set(objectType, adapter);
      }
    }
  }

  /**
   * Late registration, for adapters whose module cannot be a static dependency
   * of this one without creating a cycle (omni-inbound imports channels, which
   * imports automation-rules, which needs the core).
   */
  registerAdapter(adapter: AssignmentAdapter): void {
    for (const objectType of adapter.objectTypes) {
      this.adapters.set(objectType, adapter);
      this.logger.log(
        `Assignment adapter registered for ${objectType}: ${adapter.constructor?.name ?? 'anonymous'}`,
      );
    }
  }

  hasAdapter(objectType: AssignmentObjectType): boolean {
    return this.adapters.has(objectType);
  }

  private queuePriority(attributes?: AssignmentAttributes): number {
    const raw = attributes?.priority;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return Math.max(0, Math.min(100, Math.floor(raw)));
    }
    const named: Record<string, number> = {
      urgent: 100,
      critical: 100,
      high: 75,
      normal: 50,
      medium: 50,
      low: 25,
    };
    return named[String(raw ?? '').toLowerCase()] ?? 50;
  }

  private slaDueAt(attributes?: AssignmentAttributes): Date | null {
    const raw = attributes?.slaDueAt ?? attributes?.dueAt;
    if (!raw) return null;
    const date = new Date(raw as any);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  private workloadWeight(attributes?: AssignmentAttributes): number {
    const raw = Number(attributes?.capacityWeight ?? 1);
    return Number.isFinite(raw) && raw >= 0.1 ? raw : 1;
  }

  // ══════════════════════════════════════════════════════════════════════════

  async assign(request: AssignRequest): Promise<AssignDecision> {
    const scope: AssignmentScope = {
      tenantId: request.tenantId,
      objectType: request.objectType,
      entityId: request.entityId,
      scopeId: request.scopeId ?? null,
      commandId: request.commandId ?? null,
      queuePriority: this.queuePriority(request.attributes),
      slaDueAt: this.slaDueAt(request.attributes),
      workloadWeight: this.workloadWeight(request.attributes),
    };

    if (request.bypass) {
      return this.finish(request, {
        outcome: 'skipped',
        assigneeId: null,
        groupId: request.owningGroupId ?? null,
        strategy: 'bypass',
        reasonKey: 'bypassed',
        reason: 'Caller bypassed the assignment engine',
        rule: null,
        candidatePoolSize: 0,
        eligiblePoolSize: 0,
      });
    }

    const adapter = this.adapters.get(request.objectType);
    if (!adapter) {
      // A missing adapter is a wiring bug, not a routing outcome. Report it
      // loudly rather than looking like "nobody was available".
      this.logger.error(
        `No assignment adapter registered for ${request.objectType} — cannot assign`,
      );
      return this.finish(request, {
        outcome: 'failed',
        assigneeId: null,
        groupId: request.owningGroupId ?? null,
        strategy: 'none',
        reasonKey: 'emptyPool',
        reason: `No assignment adapter registered for ${request.objectType}`,
        rule: null,
        candidatePoolSize: 0,
        eligiblePoolSize: 0,
      });
    }

    const config = await this.config.resolve(
      request.tenantId,
      request.objectType,
      request.configOverride,
    );

    // Manual override is honoured even when auto-assign is off: the caller named
    // the person, so there is nothing to decide — only to record.
    if (request.manualAssigneeId) {
      return this.commitDirect(
        request,
        scope,
        adapter,
        request.manualAssigneeId,
        request.owningGroupId ?? config.defaultGroupId ?? null,
        'manual',
        'manualOverride',
        'Manual override — assignee provided by caller',
      );
    }

    if (!config.autoAssignEnabled) {
      return this.finish(request, {
        outcome: 'skipped',
        assigneeId: null,
        groupId: request.owningGroupId ?? null,
        strategy: 'manual',
        reasonKey: 'autoAssignDisabled',
        reason: `Auto-assignment is disabled for ${request.objectType}`,
        rule: null,
        candidatePoolSize: 0,
        eligiblePoolSize: 0,
      });
    }

    // ── Rules ──────────────────────────────────────────────────────────────
    const forcedTarget =
      (request.targetGroupIds && request.targetGroupIds.length > 0) ||
      request.targetUserId;

    let ruleMatch: RuleMatch | null = null;
    let traces: RuleTrace[] | undefined;

    if (!request.skipRules && !forcedTarget) {
      const evaluation = await this.ruleEvaluator.evaluate(
        request.tenantId,
        request.objectType,
        request.attributes ?? {},
        request.explain === true,
      );
      if (this.policyVersions && !request.dryRun) {
        const policyVersionId = await this.policyVersions.capture(
          request.tenantId,
          request.objectType,
          config,
          evaluation.rules,
        );
        request.metadata = { ...(request.metadata ?? {}), policyVersionId };
      }
      ruleMatch = evaluation.match;
      if (request.explain) traces = evaluation.traces;
    }

    const effectiveTarget: RuleMatch | null = forcedTarget
      ? {
          ruleId: ruleMatch?.ruleId ?? '',
          ruleName: ruleMatch?.ruleName ?? '',
          userId: request.targetUserId ?? null,
          groupIds: request.targetGroupIds ?? [],
          strategy: request.strategy ?? null,
          requiredSkills: request.requiredSkills ?? [],
        }
      : ruleMatch;

    const strategy: AssignmentStrategy =
      request.strategy ?? effectiveTarget?.strategy ?? config.defaultStrategy;

    const requiredSkills = [
      ...new Set([
        ...(effectiveTarget?.requiredSkills ?? []),
        ...(request.requiredSkills ?? []),
      ]),
    ];

    const ruleRef =
      ruleMatch && ruleMatch.ruleId
        ? { id: ruleMatch.ruleId, name: ruleMatch.ruleName }
        : null;

    // `manual` is a decision, not a failure: the record deliberately waits for
    // a human to pick it up, filed under the team the rule chose.
    if (strategy === 'manual') {
      const groupId =
        effectiveTarget?.groupIds?.[0] ??
        request.owningGroupId ??
        config.defaultGroupId ??
        null;
      if (groupId && !request.dryRun) await this.park(adapter, scope, groupId);
      return this.finish(request, {
        outcome: 'queued',
        assigneeId: null,
        groupId,
        strategy,
        reasonKey: 'manualStrategy',
        reason: 'Strategy is manual — queued for manual pickup',
        rule: ruleRef,
        candidatePoolSize: 0,
        eligiblePoolSize: 0,
        traces,
      });
    }

    // ── Target ─────────────────────────────────────────────────────────────
    const adapterPool = await adapter.candidates.basePool(scope);
    const basePool = request.restrictToCandidates
      ? adapterPool === undefined
        ? [...request.restrictToCandidates]
        : intersect(adapterPool, request.restrictToCandidates)
      : adapterPool;

    const target = await this.resolveTarget(
      adapter,
      scope,
      effectiveTarget,
      basePool,
      request.owningGroupId ?? config.defaultGroupId ?? null,
    );

    if (target === UNROUTABLE) {
      return this.finish(request, {
        outcome: 'queued',
        assigneeId: null,
        groupId: null,
        strategy,
        reasonKey: 'groupNotEligible',
        reason:
          `Rule "${effectiveTarget?.ruleName || 'target'}" names team(s) ` +
          `${(effectiveTarget?.groupIds ?? []).join(', ')}, none of which may serve this scope`,
        reasonParams: { groupIds: effectiveTarget?.groupIds ?? [] },
        rule: ruleRef,
        candidatePoolSize: 0,
        eligiblePoolSize: 0,
        traces,
      });
    }

    if (target.candidates.length === 0) {
      return this.queueOrFallback(
        request,
        scope,
        adapter,
        config,
        strategy,
        ruleRef,
        target.owningGroupId,
        'emptyPool',
        'No candidate is available in the resolved pool',
        target.poolSize,
        0,
        traces,
      );
    }

    // The team is known from here on: it belongs in the scope so the
    // round-robin cursor rotates per team rather than per tenant.
    const decisionScope: AssignmentScope = {
      ...scope,
      groupId: target.owningGroupId,
    };

    // ── Skills ─────────────────────────────────────────────────────────────
    const skilled = await this.filterBySkills(
      adapter,
      decisionScope,
      target.candidates,
      requiredSkills,
      config.skillBasedRoutingEnabled,
      config.skillFallbackMode,
    );

    if (skilled.length === 0) {
      return this.queueOrFallback(
        request,
        decisionScope,
        adapter,
        config,
        strategy,
        ruleRef,
        target.owningGroupId,
        'emptyPool',
        'No candidate survived skill filtering',
        target.poolSize,
        0,
        traces,
      );
    }

    // ── Availability ───────────────────────────────────────────────────────
    const eligible = adapter.candidates.filterAvailable
      ? await adapter.candidates.filterAvailable(
          decisionScope,
          skilled,
          config.requireOnline,
        )
      : skilled;

    if (eligible.length === 0) {
      return this.queueOrFallback(
        request,
        decisionScope,
        adapter,
        config,
        strategy,
        ruleRef,
        target.owningGroupId,
        'emptyPool',
        config.requireOnline
          ? 'Every candidate is offline and an online assignee is required'
          : 'No candidate is available',
        target.poolSize,
        0,
        traces,
      );
    }

    // ── Dry run stops here: everything below reserves or writes ─────────────
    if (request.dryRun) {
      const preview = await this.previewSelection(
        adapter,
        decisionScope,
        eligible,
        strategy,
        config,
      );
      return this.finish(request, {
        outcome: preview ? 'assigned' : 'queued',
        assigneeId: preview,
        groupId: target.owningGroupId,
        strategy,
        reasonKey: preview ? 'assigned' : 'allAtCapacity',
        reason: preview
          ? `Would assign via ${strategy}`
          : 'Every eligible candidate is at capacity',
        rule: ruleRef,
        candidatePoolSize: target.poolSize,
        eligiblePoolSize: eligible.length,
        traces,
      });
    }

    // ── Preferred assignee ─────────────────────────────────────────────────
    // A failed preferred attempt falls through to `stickyFallbackStrategy`
    // (the strategy meant for this case), not the rule/object default — a
    // customer who lost their sticky agent should still land somewhere
    // deliberate, not wherever the unrelated default strategy happens to put
    // them.
    let orderingStrategy: AssignmentStrategy = strategy;
    if (request.preferred && config.preferPreviousAssignee) {
      const preferredResult = await this.tryPreferred(
        request,
        decisionScope,
        adapter,
        config,
        eligible,
        target,
        ruleRef,
        traces,
      );
      if (preferredResult) return preferredResult;
      orderingStrategy = config.stickyFallbackStrategy;
    }

    // ── Reserve → commit → (release on failure) ─────────────────────────────
    const ordered = await this.orderCandidates(
      adapter,
      decisionScope,
      eligible,
      orderingStrategy,
    );

    const reserved = await adapter.load.reserve(
      decisionScope,
      ordered,
      orderingStrategy,
      config.defaultMaxCapacity,
    );

    if (!reserved) {
      return this.queueOrFallback(
        request,
        decisionScope,
        adapter,
        config,
        orderingStrategy,
        ruleRef,
        target.owningGroupId,
        'allAtCapacity',
        `No candidate could be reserved under ${orderingStrategy} — every eligible candidate is at capacity`,
        target.poolSize,
        eligible.length,
        traces,
      );
    }

    const committed = await this.commitReserved(
      request,
      decisionScope,
      adapter,
      reserved,
      target.owningGroupId,
    );

    if (!committed) {
      return this.queueOrFallback(
        request,
        decisionScope,
        adapter,
        config,
        orderingStrategy,
        ruleRef,
        target.owningGroupId,
        'commitRaceLost',
        `Reserved ${reserved} but the record was already assigned — reservation released`,
        target.poolSize,
        eligible.length,
        traces,
      );
    }

    const commitOutcome = request.commitOutcome ?? 'assigned';
    return this.finish(request, {
      outcome: commitOutcome,
      assigneeId: reserved,
      groupId: target.owningGroupId,
      strategy: orderingStrategy,
      reasonKey: commitOutcome,
      reason: ruleRef
        ? `Rule "${ruleRef.name}" matched → ${orderingStrategy} selected the assignee`
        : `Default ${orderingStrategy} assignment`,
      rule: ruleRef,
      candidatePoolSize: target.poolSize,
      eligiblePoolSize: eligible.length,
      traces,
    });
  }

  // ── Target resolution ────────────────────────────────────────────────────

  /**
   * Who may take this record, and which team it is filed under.
   *
   * Precedence: a pinned user, then the target's ordered team chain, then the
   * base pool on its own.
   *
   * The narrowing against the base pool is a hard intersection at every step.
   * An empty result queues the record; it never widens back to the base pool,
   * because "the rule's team has nobody" and "assign to anyone" are different
   * answers and silently substituting the second is how conversations reached
   * agents the matched rule never named.
   */
  private async resolveTarget(
    adapter: AssignmentAdapter,
    scope: AssignmentScope,
    target: RuleMatch | null,
    basePool: string[] | undefined,
    defaultGroupId: string | null,
  ): Promise<Target | typeof UNROUTABLE> {
    // A pinned user is still subject to the base pool: pinning must not be a
    // way around a channel's access list.
    if (target?.userId) {
      const pinned = [target.userId];
      const admitted = basePool ? intersect(pinned, basePool) : pinned;
      if (admitted.length === 0) {
        this.logger.warn(
          `Target pins ${target.userId}, who is not in the base pool for ` +
            `${scope.objectType}${scope.entityId ? ` ${scope.entityId}` : ''} — will queue`,
        );
      }
      return {
        candidates: admitted,
        owningGroupId: target.groupIds?.[0] ?? defaultGroupId,
        poolSize: 1,
      };
    }

    const chain = target?.groupIds ?? [];

    if (chain.length === 0) {
      // No team named. `undefined` base pool means unrestricted, which for a
      // record objectType means "the default group", and with no default group
      // there is genuinely nobody to choose from.
      if (basePool === undefined) {
        if (!defaultGroupId) {
          return { candidates: [], owningGroupId: null, poolSize: 0 };
        }
        const members = await adapter.candidates.groupMembers(scope, [
          defaultGroupId,
        ]);
        return {
          candidates: members,
          owningGroupId: defaultGroupId,
          poolSize: members.length,
        };
      }
      return {
        candidates: basePool,
        owningGroupId: defaultGroupId,
        poolSize: basePool.length,
      };
    }

    // Walk the escalation chain. A team the scope does not authorise is skipped
    // rather than failing the whole rule, so one chain can legitimately mix
    // teams across channels.
    let firstAuthorized: string | null = null;
    let widestPool = 0;

    for (const groupId of chain) {
      if (adapter.candidates.groupMayServe) {
        const mayServe = await adapter.candidates.groupMayServe(scope, groupId);
        if (!mayServe) {
          this.logger.warn(
            `Team ${groupId} may not serve this scope — skipping to the next tier`,
          );
          continue;
        }
      }
      firstAuthorized ??= groupId;

      const members = await adapter.candidates.groupMembers(scope, [groupId]);
      widestPool = Math.max(widestPool, members.length);
      const candidates = basePool ? intersect(members, basePool) : members;
      if (candidates.length > 0) {
        return {
          candidates,
          owningGroupId: groupId,
          poolSize: members.length,
        };
      }
    }

    // Every authorised team is empty or unavailable — park it in the first one
    // so it queues under that team rather than in a global pool.
    if (firstAuthorized) {
      return {
        candidates: [],
        owningGroupId: firstAuthorized,
        poolSize: widestPool,
      };
    }

    return UNROUTABLE;
  }

  // ── Filtering & ordering ─────────────────────────────────────────────────

  /**
   * Keep only candidates holding every required skill.
   *
   * When nobody qualifies, `config.skillFallbackMode` decides what happens:
   * `lenient` (default, historical behaviour) returns the full pool —
   * availability over precision, now visible via the `skillFallback`
   * metadata rather than a bare `logger.warn`. `strict` returns an empty
   * list instead, so the caller's empty-pool check queues the entity rather
   * than handing it to someone without the skill.
   */
  private async filterBySkills(
    adapter: AssignmentAdapter,
    scope: AssignmentScope,
    candidates: string[],
    requiredSkills: string[],
    enabled: boolean,
    fallbackMode: 'strict' | 'lenient',
  ): Promise<string[]> {
    if (!enabled || requiredSkills.length === 0) return candidates;

    const needles = requiredSkills.map((s) => s.toLowerCase());
    const skillMap = await adapter.candidates.skills(scope, candidates);

    const skilled = candidates.filter((id) => {
      const owned = (skillMap.get(id) ?? []).map((s) => s.toLowerCase());
      return needles.every((needle) => owned.includes(needle));
    });

    if (skilled.length === 0) {
      if (fallbackMode === 'strict') {
        this.logger.warn(
          `No candidate holds all of [${requiredSkills.join(', ')}] — strict mode, queueing instead of falling back`,
        );
        return [];
      }
      this.logger.warn(
        `No candidate holds all of [${requiredSkills.join(', ')}] — falling back to the full pool`,
      );
      return candidates;
    }
    return skilled;
  }

  /**
   * Order candidates the way the strategy wants them, before reservation.
   *
   * Only round-robin needs an order (rotation); the load-ordered strategies
   * decide inside the Lua script, where the scores are read atomically.
   */
  private async orderCandidates(
    adapter: AssignmentAdapter,
    scope: AssignmentScope,
    candidates: string[],
    strategy: AssignmentStrategy,
  ): Promise<string[]> {
    const plugin = this.strategies?.get(strategy);
    if (!(plugin?.rotateCandidates ?? strategy === 'round-robin')) {
      return candidates;
    }
    if (!adapter.load.rotate) return candidates;
    return adapter.load.rotate(scope, candidates);
  }

  /** Read-only "who would win" for a dry run — reserves nothing. */
  private async previewSelection(
    adapter: AssignmentAdapter,
    scope: AssignmentScope,
    candidates: string[],
    strategy: AssignmentStrategy,
    config: ResolvedAssignmentConfig,
  ): Promise<string | null> {
    const ordered = await this.orderCandidates(
      adapter,
      scope,
      candidates,
      strategy,
    );

    // Ask the load store what it would do, so the dry run and the real decision
    // cannot disagree. The approximation below is only for adapters that have
    // not implemented preview, and it cannot see per-candidate capacity.
    if (adapter.load.preview) {
      return adapter.load.preview(
        scope,
        ordered,
        strategy,
        config.defaultMaxCapacity,
      );
    }

    const loads = await adapter.load.loads(scope, candidates);
    const byLoad = (ids: string[]) =>
      [...ids].sort((a, b) => (loads.get(a) ?? 0) - (loads.get(b) ?? 0))[0] ??
      null;
    const underCapacity = candidates.filter(
      (id) => (loads.get(id) ?? 0) < config.defaultMaxCapacity,
    );

    // Mirrors the reservation scripts: least-busy ignores capacity by design,
    // the other two respect it.
    const plugin = this.strategies?.get(strategy);
    if (plugin?.loadOrdered ?? strategy !== 'round-robin') {
      return byLoad(
        (plugin?.enforceCapacity ?? strategy === 'capacity-based')
          ? underCapacity
          : candidates,
      );
    }
    return ordered.find((id) => underCapacity.includes(id)) ?? null;
  }

  // ── Preferred assignee ───────────────────────────────────────────────────

  private async tryPreferred(
    request: AssignRequest,
    scope: AssignmentScope,
    adapter: AssignmentAdapter,
    config: ResolvedAssignmentConfig,
    eligible: string[],
    target: Target,
    ruleRef: { id: string; name: string } | null,
    traces?: RuleTrace[],
  ): Promise<AssignDecision | null> {
    const preferred = request.preferred!;
    if (!eligible.includes(preferred.assigneeId)) return null;

    const reserved = await adapter.load.reserve(
      scope,
      [preferred.assigneeId],
      'capacity-based',
      config.defaultMaxCapacity,
    );

    if (!reserved) {
      const waitMinutes = config.previousAssigneeWaitMinutes;
      if (preferred.onBusy === 'wait' && waitMinutes > 0) {
        return this.finish(request, {
          outcome: 'deferred',
          assigneeId: null,
          groupId: target.owningGroupId,
          strategy: 'preferred',
          reasonKey: 'preferredWait',
          reason: `Preferred assignee ${preferred.assigneeId} is at capacity — waiting up to ${waitMinutes} min`,
          reasonParams: { minutes: waitMinutes },
          rule: ruleRef,
          candidatePoolSize: target.poolSize,
          eligiblePoolSize: eligible.length,
          deferred: { assigneeId: preferred.assigneeId, waitMinutes },
          traces,
        });
      }
      return null; // fall through to the strategy
    }

    const committed = await this.commitReserved(
      request,
      scope,
      adapter,
      reserved,
      target.owningGroupId,
    );
    if (!committed) {
      // The record was claimed while we held the reservation. Do not fall
      // through to the strategy: whoever won owns it now.
      return this.finish(request, {
        outcome: 'queued',
        assigneeId: null,
        groupId: target.owningGroupId,
        strategy: 'preferred',
        reasonKey: 'commitRaceLost',
        reason: `Preferred assignee reserved but the record was already assigned — reservation released`,
        rule: ruleRef,
        candidatePoolSize: target.poolSize,
        eligiblePoolSize: eligible.length,
        traces,
      });
    }

    const commitOutcome = request.commitOutcome ?? 'assigned';
    return this.finish(request, {
      outcome: commitOutcome,
      assigneeId: reserved,
      groupId: target.owningGroupId,
      strategy: 'preferred',
      reasonKey: commitOutcome === 'offered' ? 'offered' : 'preferredAssignee',
      reason: `Preferred assignee re-selected${preferred.source ? ` (${preferred.source})` : ''}`,
      reasonParams: preferred.source ? { source: preferred.source } : null,
      rule: ruleRef,
      candidatePoolSize: target.poolSize,
      eligiblePoolSize: eligible.length,
      traces,
    });
  }

  // ── Commit / release ─────────────────────────────────────────────────────

  /**
   * Persist a reserved candidate. Releases the reservation on any non-success —
   * a false return, a thrown write, anything. This is the invariant that
   * removes the reservation-leak class of bug entirely.
   */
  private async commitReserved(
    request: AssignRequest,
    scope: AssignmentScope,
    adapter: AssignmentAdapter,
    assigneeId: string,
    groupId: string | null,
  ): Promise<boolean> {
    const commit = request.commit
      ? () => request.commit!(assigneeId, groupId)
      : () => adapter.commit.commit(scope, assigneeId, groupId);

    try {
      const ok = await commit();
      if (!ok) {
        await adapter.load.release(scope, assigneeId);
        this.logger.warn(
          `Commit lost the race for ${scope.objectType} ${scope.entityId} — released ${assigneeId}`,
        );
      } else if (adapter.commit.complete) {
        try {
          await adapter.commit.complete(scope);
        } catch (cleanupError: any) {
          this.logger.warn(
            `Assignment committed but queue cleanup failed for ${scope.objectType} ${scope.entityId}: ${cleanupError.message}`,
          );
        }
      }
      if (ok && adapter.load.complete) {
        try {
          await adapter.load.complete(scope, assigneeId);
        } catch (leaseError: any) {
          this.logger.warn(
            `Assignment committed but reservation lease cleanup failed for ${scope.objectType} ${scope.entityId}: ${leaseError.message}`,
          );
        }
      }
      return ok;
    } catch (err: any) {
      await adapter.load.release(scope, assigneeId);
      this.logger.error(
        `Commit failed for ${scope.objectType} ${scope.entityId}: ${err.message} — released ${assigneeId}`,
        err.stack,
      );
      // Rethrow: a failed write is an error the caller must see. The
      // reservation is already rolled back, so the failure is clean.
      throw err;
    }
  }

  /** Direct assignment with no strategy — still reserves so load stays honest. */
  private async commitDirect(
    request: AssignRequest,
    scope: AssignmentScope,
    adapter: AssignmentAdapter,
    assigneeId: string,
    groupId: string | null,
    strategy: string,
    reasonKey: AssignmentReasonKey,
    reason: string,
  ): Promise<AssignDecision> {
    if (request.dryRun) {
      return this.finish(request, {
        outcome: 'assigned',
        assigneeId,
        groupId,
        strategy,
        reasonKey,
        reason,
        rule: null,
        candidatePoolSize: 1,
        eligiblePoolSize: 1,
      });
    }

    // Reserve without a capacity ceiling: a direct assignment is an
    // instruction, not a candidate selection, but the counter must still move
    // or this person looks free to the next decision.
    await adapter.load.reserve(
      scope,
      [assigneeId],
      'least-busy',
      Number.MAX_SAFE_INTEGER,
    );

    const committed = await this.commitReserved(
      request,
      scope,
      adapter,
      assigneeId,
      groupId,
    );

    if (!committed) {
      return this.finish(request, {
        outcome: 'queued',
        assigneeId: null,
        groupId,
        strategy,
        reasonKey: 'commitRaceLost',
        reason: `${reason} — but the record was already assigned; reservation released`,
        rule: null,
        candidatePoolSize: 1,
        eligiblePoolSize: 1,
      });
    }

    return this.finish(request, {
      outcome: 'assigned',
      assigneeId,
      groupId,
      strategy,
      reasonKey,
      reason,
      rule: null,
      candidatePoolSize: 1,
      eligiblePoolSize: 1,
    });
  }

  // ── Fallback / queue ─────────────────────────────────────────────────────

  /**
   * Nobody could be selected. Try the configured fallback owner, and otherwise
   * queue the record under the owning team so that team can still see it.
   */
  private async queueOrFallback(
    request: AssignRequest,
    scope: AssignmentScope,
    adapter: AssignmentAdapter,
    config: ResolvedAssignmentConfig,
    strategy: string,
    ruleRef: { id: string; name: string } | null,
    owningGroupId: string | null,
    reasonKey: AssignmentReasonKey,
    reason: string,
    candidatePoolSize: number,
    eligiblePoolSize: number,
    traces?: RuleTrace[],
  ): Promise<AssignDecision> {
    if (config.fallbackOwnerId && !request.dryRun) {
      try {
        const decision = await this.commitDirect(
          request,
          scope,
          adapter,
          config.fallbackOwnerId,
          owningGroupId,
          'fallback',
          'fallbackOwner',
          `${reason} — assigned to the configured fallback owner`,
        );
        if (decision.outcome === 'assigned') return decision;
      } catch (err: any) {
        // A failing fallback must not swallow the original outcome.
        this.logger.error(
          `Fallback owner assignment failed for ${scope.objectType} ${scope.entityId}: ${err.message}`,
        );
      }
    }

    if (owningGroupId && !request.dryRun) {
      await this.park(adapter, scope, owningGroupId);
    }

    return this.finish(request, {
      outcome: 'queued',
      assigneeId: null,
      groupId: owningGroupId,
      strategy,
      reasonKey,
      reason,
      rule: ruleRef,
      candidatePoolSize,
      eligiblePoolSize,
      traces,
    });
  }

  /** Tag the queue with its owning team. Best-effort by contract. */
  private async park(
    adapter: AssignmentAdapter,
    scope: AssignmentScope,
    groupId: string,
  ): Promise<void> {
    if (!adapter.commit.park) return;
    try {
      await adapter.commit.park(scope, groupId);
    } catch (err: any) {
      this.logger.warn(
        `Failed to park ${scope.objectType} ${scope.entityId} under ${groupId}: ${err.message}`,
      );
    }
  }

  // ── Audit ────────────────────────────────────────────────────────────────

  /**
   * Single exit point: every decision is audited here, exactly once.
   *
   * Centralising it is what removes the duplicate-row and missing-row bugs the
   * old engines had (one suppressed its inner write with a flag, the other
   * wrote from nine different places).
   */
  private async finish(
    request: AssignRequest,
    decision: AssignDecision,
  ): Promise<AssignDecision> {
    decision.policyVersionId =
      (request.metadata?.policyVersionId as string | undefined) ?? null;
    if (request.dryRun) return decision;

    const entry: WriteAuditEntry = {
      tenantId: request.tenantId,
      objectType: request.objectType,
      entityId: request.entityId ?? 'pre-create',
      assigneeId: decision.assigneeId,
      previousAssigneeId: request.previousAssigneeId ?? null,
      groupId: decision.groupId,
      ruleId: decision.rule?.id ?? null,
      ruleName: decision.rule?.name ?? null,
      strategy: decision.strategy,
      outcome: decision.outcome,
      reason: decision.reason,
      reasonKey: decision.reasonKey,
      reasonParams: decision.reasonParams ?? null,
      source: request.source ?? 'system',
      sourceWorkflowId: request.sourceWorkflowId ?? null,
      performedByUserId: request.performedByUserId ?? null,
      channelType: request.channelType ?? null,
      candidatePoolSize: decision.candidatePoolSize,
      eligiblePoolSize: decision.eligiblePoolSize,
      metadata: {
        scopeId: request.scopeId ?? null,
        commandId: request.commandId ?? null,
        ...(request.metadata ?? {}),
      },
    };

    await this.audit.write(entry);
    return decision;
  }

  /**
   * Record a decision the core did not make — a human clicking "assign", an
   * agent replying to an unassigned record. Same trail, so the history page
   * shows manual and automatic decisions side by side.
   */
  async recordExternalDecision(entry: WriteAuditEntry): Promise<void> {
    await this.audit.write(entry);
  }
}
