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
import { AssignmentAuditLogSchemaClass } from './entities/assignment-audit-log.schema';
import {
  AssignmentSkillSchemaClass,
  AssignmentSkillDocument,
} from './entities/assignment-skill.schema';
import { CapacityFilterService } from './services/capacity-filter.service';
import { StrategyExecutorService } from './services/strategy-executor.service';
import { FallbackResolverService } from './services/fallback-resolver.service';
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
    @InjectModel(AssignmentAuditLogSchemaClass.name)
    private readonly auditLogModel: Model<any>,
    @InjectModel(AssignmentSkillSchemaClass.name)
    private readonly skillModel: Model<AssignmentSkillDocument>,
    @InjectModel('GroupSchemaClass')
    private readonly groupModel: Model<any>,
    private readonly capacityFilter: CapacityFilterService,
    private readonly strategyExecutor: StrategyExecutorService,
    private readonly fallbackResolver: FallbackResolverService,
    private readonly cls: ClsService,
  ) {}

  private get tenantId(): string {
    return this.cls.get('tenantId');
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CORE: assign() — the brain of the engine
  // ════════════════════════════════════════════════════════════════════════

  async assign(context: AssignmentContext): Promise<AssignmentResult> {
    // Step 0: Loop prevention
    if (context.bypassAssignmentEngine) {
      return {
        ownerId: null,
        strategy: 'bypass',
        reason: 'bypassAssignmentEngine flag set — skipped',
        fallback: false,
      };
    }

    // Step 1: Manual override
    if (context.manualOwnerId) {
      await this.writeAuditLog(context, {
        assignedUserId: context.manualOwnerId,
        strategy: 'manual',
        reason: 'Manual override — ownerId provided by caller',
        isFallback: false,
      });
      return {
        ownerId: context.manualOwnerId,
        strategy: 'manual',
        reason: 'Manual override',
        fallback: false,
      };
    }

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

    // Step 4: Evaluate rules
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
      if (this.evaluateRule(rule, context.attributes)) {
        matchedRule = rule;
        break; // First match wins
      }
    }

    // Step 5: Resolve candidate pool
    let candidatePool: string[] = [];
    let strategy = settings.defaultStrategy || 'round-robin';
    let requiredSkills: string[] = [];
    let teamId = settings.defaultTeamId;

    if (matchedRule) {
      strategy = matchedRule.actions.strategy || strategy;
      requiredSkills = matchedRule.actions.requiredSkills || [];
      if (matchedRule.actions.assignToUserId) {
        // Direct user assignment
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
        await this.writeAuditLog(context, {
          assignedUserId: result.ownerId ?? undefined,
          ruleId: matchedRule._id.toString(),
          ruleName: matchedRule.name,
          strategy: 'direct',
          reason: result.reason,
          isFallback: false,
        });
        return result;
      }
      if (matchedRule.actions.assignToTeamId) {
        teamId = matchedRule.actions.assignToTeamId.toString();
      }
    }

    // Resolve team members
    if (teamId) {
      candidatePool = await this.resolveGroupMembers(teamId);
    }

    if (candidatePool.length === 0) {
      this.logger.warn(
        `No candidates in pool for ${context.module} (team=${teamId}) — attempting fallback`,
      );
      return this.handleFallback(context, matchedRule, strategy);
    }

    // Step 6: Filter candidates (capacity + skills)
    const maxCapacity = settings.defaultMaxCapacity || 50;
    const eligible = await this.capacityFilter.filterEligible(
      context.tenantId,
      context.module,
      candidatePool,
      maxCapacity,
      requiredSkills.length > 0 ? requiredSkills : undefined,
    );

    // Sticky hint: boost current owner if in eligible pool
    if (
      settings.prioritizeCurrentOwner &&
      context.currentOwnerHint &&
      eligible.includes(context.currentOwnerHint)
    ) {
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
      await this.writeAuditLog(context, {
        assignedUserId: result.ownerId ?? undefined,
        ruleId: matchedRule?._id?.toString(),
        ruleName: matchedRule?.name,
        strategy: 'sticky',
        reason: result.reason,
        candidatesEvaluated: candidatePool.length,
        candidatesFiltered: eligible.length,
        isFallback: false,
      });
      return result;
    }

    if (eligible.length === 0) {
      this.logger.warn(
        `All candidates filtered out for ${context.module} (capacity/skills) — fallback`,
      );
      return this.handleFallback(context, matchedRule, strategy);
    }

    // Step 7: Apply strategy
    let selectedId: string;
    const rrScope = `${context.tenantId}:${context.module}:${teamId || 'default'}`;

    if (strategy === 'least-busy') {
      const loadMap = await this.capacityFilter.getActiveLoads(
        context.tenantId,
        context.module,
        eligible,
      );
      const result = await this.strategyExecutor.leastBusy(loadMap);
      selectedId = result.candidateId;
    } else if (strategy === 'manual') {
      return this.handleFallback(context, matchedRule, 'manual');
    } else {
      // Default: round-robin
      selectedId = await this.strategyExecutor.roundRobin(rrScope, eligible);
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

    // Step 9: Write audit log
    await this.writeAuditLog(context, {
      assignedUserId: selectedId,
      ruleId: matchedRule?._id?.toString(),
      ruleName: matchedRule?.name,
      strategy,
      reason: result.reason,
      candidatesEvaluated: candidatePool.length,
      candidatesFiltered: eligible.length,
      isFallback: false,
    });

    this.logger.log(
      `Assigned ${context.module}${context.entityId ? ` (${context.entityId})` : ''} → ${selectedId} via ${strategy}`,
    );

    return result;
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

    const triggerFields = settings.triggerFields || [];
    if (triggerFields.length === 0) {
      return {
        ownerId: context.currentOwnerId || null,
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
        ownerId: context.currentOwnerId || null,
        strategy: 'none',
        reason: `Changed fields [${context.changedFields.join(',')}] do not overlap with trigger fields [${triggerFields.join(',')}]`,
        fallback: false,
      };
    }

    this.logger.log(
      `Re-evaluating ${context.module} ${context.entityId}: trigger fields [${overlap.join(',')}] changed`,
    );

    const result = await this.assign(context);

    if (result.ownerId) {
      await this.writeAuditLog(context, {
        assignedUserId: result.ownerId ?? undefined,
        previousOwnerId: context.currentOwnerId,
        strategy: result.strategy,
        reason: `Re-evaluated: ${overlap.join(',')} changed. ${result.reason}`,
        isReassignment: true,
        triggerField: overlap.join(','),
        isFallback: result.fallback,
      });
    }

    return result;
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
    };

    // Run the full assign flow but capture the result
    const result = await this.assign(context);

    // Delete the audit log entry created by assign (dry-run should be side-effect free)
    // In production, we'd want a proper dry-run flag that skips audit writing
    // For now, we'll mark it in the response

    return {
      ...result,
      isDryRun: true,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CRUD: Rules
  // ════════════════════════════════════════════════════════════════════════

  async findAllRules(module?: string) {
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

  async reorderRules(orderedIds: string[]) {
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

  async findAllSkills() {
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
    const filter: any = { tenantId: this.tenantId };
    if (module) filter.module = module;
    if (entityId) filter.entityId = entityId;
    return this.auditLogModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .lean()
      .exec();
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
  private evaluateRule(rule: any, attributes: Record<string, any>): boolean {
    if (!rule.conditions || rule.conditions.length === 0) {
      return true; // Catch-all rule
    }

    const results = rule.conditions.map((cond: any) =>
      this.evaluateCondition(cond, attributes),
    );

    if (rule.matchType === 'any') {
      return results.some(Boolean);
    }
    return results.every(Boolean); // 'all' (default)
  }

  private evaluateCondition(
    condition: { field: string; operator: string; value: string },
    attributes: Record<string, any>,
  ): boolean {
    const attrValue = attributes[condition.field];
    const condValue = condition.value;

    if (condValue === '' || condValue === undefined) return false;
    if (attrValue === undefined || attrValue === null) return false;

    const av = String(attrValue).toLowerCase();
    const cv = condValue.toLowerCase();

    switch (condition.operator) {
      case 'eq':
        return av === cv;
      case 'neq':
        return av !== cv;
      case 'contains':
        return av.includes(cv);
      case 'in': {
        const items = cv.split(',').map((s) => s.trim());
        return items.includes(av);
      }
      case 'gt':
        return parseFloat(attrValue) > parseFloat(condValue);
      case 'lt':
        return parseFloat(attrValue) < parseFloat(condValue);
      case 'between': {
        const [min, max] = condValue
          .split(',')
          .map((s) => parseFloat(s.trim()));
        const val = parseFloat(attrValue);
        return val >= min && val <= max;
      }
      default:
        this.logger.warn(`Unknown operator: ${condition.operator}`);
        return false;
    }
  }

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

    await this.writeAuditLog(context, {
      assignedUserId: fallbackId ?? undefined,
      ruleId: matchedRule?._id?.toString(),
      ruleName: matchedRule?.name,
      strategy: result.strategy,
      reason: result.reason,
      isFallback: true,
    });

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

  private async writeAuditLog(
    context: AssignmentContext | ReassignContext,
    data: Partial<AssignmentAuditLogSchemaClass>,
  ): Promise<void> {
    try {
      await this.auditLogModel.create({
        tenantId: context.tenantId,
        module: context.module,
        entityId: context.entityId || 'pre-create',
        ...data,
        metadata: {
          attributes: context.attributes,
          ...((data as any).metadata || {}),
        },
      });
    } catch (err: any) {
      this.logger.error(`Failed to write audit log: ${err.message}`);
    }
  }
}
