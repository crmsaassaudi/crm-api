import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import {
  AssignmentRuleSchemaClass,
  AssignmentRuleDocument,
} from './entities/assignment-rule.schema';
import {
  AssignmentSettingSchemaClass,
  AssignmentSettingDocument,
} from './entities/assignment-setting.schema';
import {
  AssignmentSkillSchemaClass,
  AssignmentSkillDocument,
} from './entities/assignment-skill.schema';
import { CapacityFilterService } from './services/capacity-filter.service';
import { StrategyExecutorService } from './services/strategy-executor.service';
import { FallbackResolverService } from './services/fallback-resolver.service';
import { RuleEvaluatorService } from './services/rule-evaluator.service';
import { AssignmentAuditService } from './services/assignment-audit.service';
import {
  CreateAssignmentRuleDto,
  UpdateAssignmentRuleDto,
  UpdateAssignmentSettingDto,
  CreateAssignmentSkillDto,
  DryRunDto,
} from './dto/assignment-engine.dto';

// ── Types ──────────────────────────────────────────────────────────────────

export interface AssignmentContext {
  module: 'Contact' | 'Ticket' | 'Task' | 'Deal';
  tenantId: string;
  entityId?: string;
  attributes: Record<string, any>;
  manualOwnerId?: string;
  currentOwnerHint?: string;
  bypassAssignmentEngine?: boolean;
  /**
   * When true, assign() simulates the decision WITHOUT side effects: no audit
   * log is written and no Redis reservation (round-robin cursor / least-busy
   * ZINCRBY) is mutated. Used by dryRun() (CRIT-06).
   */
  dryRun?: boolean;
  /**
   * Internal: suppress audit writing inside assign() when it is invoked from
   * reassign(), which writes its own enriched re-assignment audit entry. Avoids
   * the duplicate audit row (MED-08).
   */
  suppressAudit?: boolean;
}

export interface ReassignContext extends AssignmentContext {
  currentOwnerId?: string;
  changedFields: string[];
}

export interface AssignmentResult {
  ownerId: string | null;
  ruleMatched?: { id: string; name: string };
  strategy: string;
  reason: string;
  fallback: boolean;
}

// ── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class AssignmentEngineService {
  private readonly logger = new Logger(AssignmentEngineService.name);

  constructor(
    @InjectModel(AssignmentRuleSchemaClass.name)
    private readonly ruleModel: Model<AssignmentRuleDocument>,
    @InjectModel(AssignmentSettingSchemaClass.name)
    private readonly settingModel: Model<AssignmentSettingDocument>,
    @InjectModel(AssignmentSkillSchemaClass.name)
    private readonly skillModel: Model<AssignmentSkillDocument>,
    @InjectModel('GroupSchemaClass')
    private readonly groupModel: Model<any>,
    private readonly capacityFilter: CapacityFilterService,
    private readonly strategyExecutor: StrategyExecutorService,
    private readonly fallbackResolver: FallbackResolverService,
    private readonly ruleEvaluator: RuleEvaluatorService,
    private readonly audit: AssignmentAuditService,
    private readonly cls: ClsService,
  ) {}

  private get tenantId(): string {
    return this.cls.get('tenantId');
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CORE: assign() — the brain of the engine
  // ════════════════════════════════════════════════════════════════════════

  /** Step 0–1: short-circuit for bypass flag and manual override. */
  private async handleBypassOrManual(
    context: AssignmentContext,
  ): Promise<AssignmentResult | null> {
    if (context.bypassAssignmentEngine) {
      return {
        ownerId: null,
        strategy: 'bypass',
        reason: 'bypassAssignmentEngine flag set — skipped',
        fallback: false,
      };
    }

    if (context.manualOwnerId) {
      if (!context.dryRun) {
        await this.audit.write(context, {
          assignedUserId: context.manualOwnerId,
          strategy: 'manual',
          reason: 'Manual override — ownerId provided by caller',
          isFallback: false,
        });
      }
      return {
        ownerId: context.manualOwnerId,
        strategy: 'manual',
        reason: 'Manual override',
        fallback: false,
      };
    }

    return null;
  }

  /**
   * Steps 4–5: evaluate rules, resolve the candidate pool.
   * Returns the matched rule, resolved strategy, candidate pool, required skills,
   * or an AssignmentResult directly (direct-user assignment fast path).
   */
  private async resolveCandidatePool(
    context: AssignmentContext,
    settings: any,
  ): Promise<
    | {
        matchedRule: any;
        strategy: string;
        candidatePool: string[];
        requiredSkills: string[];
      }
    | AssignmentResult
  > {
    const rules = await this.ruleModel
      .find({
        tenantId: context.tenantId,
        module: context.module,
        enabled: true,
      })
      .sort({ priority: 1 })
      .lean()
      .exec();

    let matchedRule: any = null;
    for (const rule of rules) {
      if (this.ruleEvaluator.evaluateRule(rule, context.attributes)) {
        matchedRule = rule;
        break;
      }
    }

    let strategy = settings.defaultStrategy ?? 'round-robin';
    let requiredSkills: string[] = [];
    let teamId = settings.defaultTeamId;

    if (matchedRule) {
      strategy = matchedRule.actions.strategy ?? strategy;
      requiredSkills = matchedRule.actions.requiredSkills ?? [];

      if (matchedRule.actions.assignToUserId) {
        const result: AssignmentResult = {
          ownerId: matchedRule.actions.assignToUserId.toString(),
          ruleMatched: {
            id: matchedRule._id.toString(),
            name: matchedRule.name,
          },
          strategy: 'direct',
          reason: `Rule "${matchedRule.name}" matched — direct user assignment`,
          fallback: false,
        };
        if (!context.dryRun) {
          await this.audit.write(context, {
            assignedUserId: result.ownerId ?? undefined,
            ruleId: matchedRule._id.toString(),
            ruleName: matchedRule.name,
            strategy: 'direct',
            reason: result.reason,
            isFallback: false,
          });
        }
        return result;
      }

      if (matchedRule.actions.assignToTeamId) {
        teamId = matchedRule.actions.assignToTeamId.toString();
      }
    }

    const candidatePool: string[] = teamId
      ? await this.resolveGroupMembers(teamId)
      : [];

    return { matchedRule, strategy, candidatePool, requiredSkills };
  }

  /** Step 6 sub-step: sticky-hint check — returns result if the hint wins. */
  private async applyStickyHint(
    context: AssignmentContext,
    settings: any,
    eligible: string[],
    matchedRule: any,
    candidatePool: string[],
  ): Promise<AssignmentResult | null> {
    if (
      !settings.prioritizeCurrentOwner ||
      !context.currentOwnerHint ||
      !eligible.includes(context.currentOwnerHint)
    ) {
      return null;
    }

    this.logger.debug(
      `Sticky hint: prioritizing currentOwnerHint=${context.currentOwnerHint}`,
    );
    const result: AssignmentResult = {
      ownerId: context.currentOwnerHint,
      ruleMatched: matchedRule
        ? { id: matchedRule._id.toString(), name: matchedRule.name }
        : undefined,
      strategy: 'sticky',
      reason: 'Sticky: prioritized current owner from Omni-Channel',
      fallback: false,
    };
    if (!context.dryRun) {
      await this.audit.write(context, {
        assignedUserId: result.ownerId ?? undefined,
        ruleId: matchedRule?._id?.toString(),
        ruleName: matchedRule?.name,
        strategy: 'sticky',
        reason: result.reason,
        candidatesEvaluated: candidatePool.length,
        candidatesFiltered: eligible.length,
        isFallback: false,
      });
    }
    return result;
  }

  /** Steps 7–9: dispatch strategy, write audit, return final result. */
  private async executeStrategy(
    context: AssignmentContext,
    settings: any,
    matchedRule: any,
    options: {
      eligible: string[];
      eligibleLoadMap: Map<string, number>;
      strategy: string;
      candidatePool: string[];
      teamId: string | undefined;
    },
  ): Promise<AssignmentResult> {
    const { eligible, eligibleLoadMap, strategy, candidatePool, teamId } =
      options;
    const reserve = !context.dryRun;
    const rrScope = `${context.tenantId}:${context.module}:${teamId ?? 'default'}`;

    let selectedId: string | null;

    if (strategy === 'least-busy') {
      const loadMap = new Map(
        eligible.map((id) => [id, eligibleLoadMap.get(id) ?? 0]),
      );
      const res = await this.strategyExecutor.leastBusyAtomic(
        rrScope,
        loadMap,
        undefined,
        reserve,
      );
      selectedId = res?.candidateId ?? null;
    } else if (strategy === 'manual') {
      return this.handleFallback(context, matchedRule, 'manual');
    } else {
      selectedId = await this.strategyExecutor.roundRobin(
        rrScope,
        eligible,
        reserve,
      );
    }

    if (!selectedId) {
      this.logger.warn(
        `Strategy ${strategy} could not select a candidate for ${context.module} — fallback`,
      );
      return this.handleFallback(context, matchedRule, strategy);
    }

    const result: AssignmentResult = {
      ownerId: selectedId,
      ruleMatched: matchedRule
        ? { id: matchedRule._id.toString(), name: matchedRule.name }
        : undefined,
      strategy,
      reason: matchedRule
        ? `Rule "${matchedRule.name}" matched → ${strategy} selected agent`
        : `No rules matched → default ${strategy} assignment`,
      fallback: false,
    };

    if (!context.dryRun) {
      await this.audit.write(context, {
        assignedUserId: selectedId,
        ruleId: matchedRule?._id?.toString(),
        ruleName: matchedRule?.name,
        strategy,
        reason: result.reason,
        candidatesEvaluated: candidatePool.length,
        candidatesFiltered: eligible.length,
        isFallback: false,
      });
    }

    this.logger.log(
      `Assigned ${context.module}${context.entityId ? ` (${context.entityId})` : ''} → ${selectedId} via ${strategy}`,
    );

    return result;
  }

  async assign(context: AssignmentContext): Promise<AssignmentResult> {
    // Steps 0–1: bypass / manual override
    const earlyResult = await this.handleBypassOrManual(context);
    if (earlyResult) return earlyResult;

    // Step 2: Load settings
    const settings = await this.getOrCreateSettings(
      context.tenantId,
      context.module,
    );

    // Step 3: Check if auto-assign is enabled
    if (!settings.autoAssignEnabled) {
      return {
        ownerId: null,
        strategy: 'manual',
        reason: 'Auto-assignment disabled for this module',
        fallback: false,
      };
    }

    // Steps 4–5: evaluate rules + resolve candidate pool
    const poolResult = await this.resolveCandidatePool(context, settings);
    // Direct-user assignment short-circuit
    if ('ownerId' in poolResult) return poolResult;

    const { matchedRule, strategy, candidatePool, requiredSkills } = poolResult;
    const teamId =
      matchedRule?.actions?.assignToTeamId?.toString() ??
      settings.defaultTeamId;

    if (candidatePool.length === 0) {
      this.logger.warn(
        `No candidates in pool for ${context.module} (team=${teamId}) — attempting fallback`,
      );
      return this.handleFallback(context, matchedRule, strategy);
    }

    // Step 6: Filter candidates (capacity + skills)
    const maxCapacity = settings.defaultMaxCapacity ?? 50;
    const { eligible, loadMap: eligibleLoadMap } =
      await this.capacityFilter.filterEligible(
        context.tenantId,
        context.module,
        candidatePool,
        maxCapacity,
        requiredSkills.length > 0 ? requiredSkills : undefined,
      );

    // Sticky hint: boost current owner if in eligible pool
    const stickyResult = await this.applyStickyHint(
      context,
      settings,
      eligible,
      matchedRule,
      candidatePool,
    );
    if (stickyResult) return stickyResult;

    if (eligible.length === 0) {
      this.logger.warn(
        `All candidates filtered out for ${context.module} (capacity/skills) — fallback`,
      );
      return this.handleFallback(context, matchedRule, strategy);
    }

    // Steps 7–9: execute strategy, audit, return
    return this.executeStrategy(context, settings, matchedRule, {
      eligible,
      eligibleLoadMap,
      strategy,
      candidatePool,
      teamId,
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  //  REASSIGN — trigger-based re-evaluation
  // ════════════════════════════════════════════════════════════════════════

  async reassign(context: ReassignContext): Promise<AssignmentResult> {
    // Load settings to check trigger fields
    const settings = await this.getOrCreateSettings(
      context.tenantId,
      context.module,
    );

    const triggerFields = settings.triggerFields ?? [];
    if (triggerFields.length === 0) {
      return {
        ownerId: context.currentOwnerId ?? null,
        strategy: 'none',
        reason: 'No trigger fields configured — skipping re-evaluation',
        fallback: false,
      };
    }

    // Check if any changed fields overlap with trigger fields
    const overlap = context.changedFields.filter((f) =>
      triggerFields.includes(f),
    );
    if (overlap.length === 0) {
      return {
        ownerId: context.currentOwnerId ?? null,
        strategy: 'none',
        reason: `Changed fields [${context.changedFields.join(',')}] do not overlap with trigger fields [${triggerFields.join(',')}]`,
        fallback: false,
      };
    }

    this.logger.log(
      `Re-evaluating ${context.module} ${context.entityId}: trigger fields [${overlap.join(',')}] changed`,
    );

    // Suppress assign()'s own audit write — reassign emits a single enriched
    // re-assignment entry below instead of two rows (MED-08).
    const result = await this.assign({ ...context, suppressAudit: true });

    if (result.ownerId) {
      // Re-enable auditing for this explicit reassignment record.
      await this.audit.write(
        { ...context, suppressAudit: false },
        {
          assignedUserId: result.ownerId ?? undefined,
          previousOwnerId: context.currentOwnerId,
          strategy: result.strategy,
          reason: `Re-evaluated: ${overlap.join(',')} changed. ${result.reason}`,
          isReassignment: true,
          triggerField: overlap.join(','),
          isFallback: result.fallback,
        },
      );
    }

    return result;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  COMPENSATE — roll back a reservation when persistence fails (CRIT-05)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Callers that reserve a candidate via assign() and then fail to persist the
   * resulting ownerId MUST call this to roll back the Redis reservation,
   * otherwise the round-robin cursor / least-busy counter drifts.
   *
   * The scope mirrors the one assign() builds internally:
   * `${tenantId}:${module}:${teamId || 'default'}`.
   */
  async compensate(params: {
    tenantId: string;
    module: string;
    candidateId: string;
    strategy: string;
    teamId?: string | null;
  }): Promise<void> {
    const scope = `${params.tenantId}:${params.module}:${params.teamId ?? 'default'}`;
    await this.strategyExecutor.release(
      scope,
      params.candidateId,
      params.strategy,
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  //  DRY RUN — simulate assignment without side effects
  // ════════════════════════════════════════════════════════════════════════

  async dryRun(dto: DryRunDto): Promise<any> {
    const tenantId = this.tenantId;
    const context: AssignmentContext = {
      module: dto.module as any,
      tenantId,
      attributes: dto.attributes,
      // CRIT-06: side-effect-free — assign() skips audit writes and Redis
      // reservations when this flag is set.
      dryRun: true,
    };

    const result = await this.assign(context);

    return {
      ...result,
      isDryRun: true,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CRUD: Rules
  // ════════════════════════════════════════════════════════════════════════

  async findAllRules(module?: string): Promise<any[]> {
    const filter: any = { tenantId: this.tenantId };
    if (module) filter.module = module;
    return this.ruleModel.find(filter).sort({ priority: 1 }).lean().exec();
  }

  async createRule(dto: CreateAssignmentRuleDto) {
    // Auto-set priority to end of list
    if (dto.priority === undefined) {
      const count = await this.ruleModel.countDocuments({
        tenantId: this.tenantId,
        module: dto.module,
      });
      dto.priority = count;
    }
    return this.ruleModel.create({ ...dto, tenantId: this.tenantId });
  }

  async updateRule(id: string, dto: UpdateAssignmentRuleDto) {
    const rule = await this.ruleModel
      .findOneAndUpdate({ _id: id, tenantId: this.tenantId }, dto, {
        new: true,
      })
      .exec();
    if (!rule) throw new NotFoundException('Assignment rule not found');
    return rule;
  }

  async deleteRule(id: string) {
    const result = await this.ruleModel
      .deleteOne({ _id: id, tenantId: this.tenantId })
      .exec();
    if (result.deletedCount === 0)
      throw new NotFoundException('Assignment rule not found');
  }

  async reorderRules(orderedIds: string[]): Promise<any[]> {
    const ops = orderedIds.map((id, idx) => ({
      updateOne: {
        filter: { _id: id, tenantId: this.tenantId },
        update: { $set: { priority: idx } },
      },
    }));
    await this.ruleModel.bulkWrite(ops);
    return this.findAllRules();
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CRUD: Settings
  // ════════════════════════════════════════════════════════════════════════

  async getSettings(module: string) {
    return this.getOrCreateSettings(this.tenantId, module);
  }

  async updateSettings(module: string, dto: UpdateAssignmentSettingDto) {
    return this.settingModel
      .findOneAndUpdate(
        { tenantId: this.tenantId, module },
        { $set: dto },
        { new: true, upsert: true },
      )
      .exec();
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CRUD: Skills
  // ════════════════════════════════════════════════════════════════════════

  async findAllSkills(): Promise<any[]> {
    return this.skillModel
      .find({ tenantId: this.tenantId })
      .sort({ category: 1, name: 1 })
      .lean()
      .exec();
  }

  async createSkill(dto: CreateAssignmentSkillDto) {
    const apiName = dto.name
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '');

    return this.skillModel.create({
      ...dto,
      apiName,
      tenantId: this.tenantId,
    });
  }

  async deleteSkill(id: string) {
    const result = await this.skillModel
      .deleteOne({ _id: id, tenantId: this.tenantId })
      .exec();
    if (result.deletedCount === 0)
      throw new NotFoundException('Assignment skill not found');
  }

  // ════════════════════════════════════════════════════════════════════════
  //  Audit Log
  // ════════════════════════════════════════════════════════════════════════

  async getAuditLog(module?: string, entityId?: string) {
    return this.audit.getAuditLog(module, entityId);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  PRIVATE HELPERS
  // ════════════════════════════════════════════════════════════════════════

  private async getOrCreateSettings(
    tenantId: string,
    module: string,
  ): Promise<any> {
    const setting = await this.settingModel
      .findOne({ tenantId, module })
      .lean()
      .exec();

    if (!setting) {
      // Return defaults without persisting
      return {
        tenantId,
        module,
        autoAssignEnabled: false,
        defaultStrategy: 'round-robin',
        defaultMaxCapacity: 50,
        prioritizeCurrentOwner: false,
        triggerFields: [],
        respectWorkingHours: false,
      };
    }

    return setting;
  }

  /**
   * Evaluate a single rule against entity attributes.
   */
  private async handleFallback(
    context: AssignmentContext,
    matchedRule: any,
    strategy: string,
  ): Promise<AssignmentResult> {
    const fallbackId = await this.fallbackResolver.resolve(
      context.tenantId,
      context.module,
    );

    const result: AssignmentResult = {
      ownerId: fallbackId,
      ruleMatched: matchedRule
        ? { id: matchedRule._id.toString(), name: matchedRule.name }
        : undefined,
      strategy: fallbackId ? 'fallback' : strategy,
      reason: fallbackId
        ? 'No eligible candidates — assigned to fallback owner'
        : 'No eligible candidates and no fallback configured — entity unassigned',
      fallback: true,
    };

    if (!context.dryRun) {
      await this.audit.write(context, {
        assignedUserId: fallbackId ?? undefined,
        ruleId: matchedRule?._id?.toString(),
        ruleName: matchedRule?.name,
        strategy: result.strategy,
        reason: result.reason,
        isFallback: true,
      });
    }

    return result;
  }

  private async resolveGroupMembers(groupId: string): Promise<string[]> {
    try {
      const group: any = await this.groupModel.findById(groupId).lean().exec();
      if (!group) return [];
      const members = group.memberIds ?? group.members ?? [];
      return Array.isArray(members) ? members.map(String) : [];
    } catch (err: any) {
      this.logger.warn(`Failed to resolve group ${groupId}: ${err.message}`);
      return [];
    }
  }
}
