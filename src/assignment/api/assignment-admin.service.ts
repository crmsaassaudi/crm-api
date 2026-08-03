import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { InjectConnection } from '@nestjs/mongoose';
import { ClsService } from 'nestjs-cls';
import { AssignmentRuleRepository } from '../infrastructure/persistence/assignment-rule.repository';
import {
  AssignmentSkillDocument,
  AssignmentSkillSchemaClass,
  toSkillApiName,
} from '../infrastructure/persistence/assignment-skill.schema';
import { AssignmentConfigService } from '../core/assignment-config.service';
import { AssignmentRuleEvaluatorService } from '../core/rule-evaluator.service';
import { AssignmentCoreService } from '../core/assignment-core.service';
import { AssignmentAuditLogRepository } from '../infrastructure/persistence/assignment-audit-log.repository';
import {
  AssignmentObjectType,
  AssignmentOutcome,
  AssignmentSource,
  VALUELESS_OPERATORS,
  ConditionOperator,
  isAssignmentObjectType,
} from '../domain/assignment.types';
import {
  builtInFieldsFor,
  operatorsForFieldType,
} from '../domain/assignment-fields';
import {
  CreateAssignmentRuleDto,
  CreateAssignmentSkillDto,
  DryRunDto,
  UpdateAssignmentRuleDto,
  UpdateAssignmentSettingDto,
  UpdateAssignmentSkillDto,
} from './dto/assignment.dto';
import {
  AssignmentQueueItemDocument,
  AssignmentQueueItemSchemaClass,
} from '../infrastructure/persistence/assignment-queue-item.schema';

/** Serialisable skill, so no Mongoose document type leaks into the API. */
export interface AssignmentSkillView {
  id: string;
  name: string;
  apiName: string;
  category: string | null;
  description: string | null;
}

export interface AssignmentQueueItemView {
  _id: unknown;
  objectType: string;
  entityId: string;
  groupId: unknown;
  status: 'queued';
  queuedAt: Date;
  priority?: number;
  slaDueAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Admin-facing operations: rule/settings/skill CRUD, dry run, audit reads.
 *
 * Deliberately separate from AssignmentCoreService. The core is on the inbound
 * hot path and has no CLS/tenant-from-request dependency; mixing the two is
 * what turned the old engine into a 711-line service that both decided
 * assignments and served CRUD.
 */
@Injectable()
export class AssignmentAdminService {
  constructor(
    private readonly rules: AssignmentRuleRepository,
    private readonly config: AssignmentConfigService,
    private readonly evaluator: AssignmentRuleEvaluatorService,
    private readonly core: AssignmentCoreService,
    private readonly audit: AssignmentAuditLogRepository,
    @InjectModel(AssignmentSkillSchemaClass.name)
    private readonly skillModel: Model<AssignmentSkillDocument>,
    @InjectModel('GroupSchemaClass')
    private readonly groupModel: Model<any>,
    @InjectModel(AssignmentQueueItemSchemaClass.name)
    private readonly queueItemModel: Model<AssignmentQueueItemDocument>,
    @InjectConnection()
    private readonly connection: Connection,
    private readonly cls: ClsService,
  ) {}

  private get tenantId(): string {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new BadRequestException('Tenant context is missing');
    }
    return tenantId;
  }

  private objectTypeOf(value: string): AssignmentObjectType {
    if (!isAssignmentObjectType(value)) {
      throw new BadRequestException(`Unknown objectType: ${value}`);
    }
    return value;
  }

  // Rules

  /**
   * Reject conditions the evaluator could only ever answer "no" to.
   *
   * Both of these used to be accepted and then silently never match, which is
   * the worst possible outcome for a routing rule: it looks configured and does
   * nothing.
   */
  private validateConditions(
    objectType: AssignmentObjectType,
    conditions: Array<{ field: string; operator: string; value?: string }>,
  ): void {
    const builtIns = new Map(
      builtInFieldsFor(objectType).map((f) => [f.key, f]),
    );

    for (const condition of conditions) {
      const operator = condition.operator as ConditionOperator;
      const needsValue = !VALUELESS_OPERATORS.includes(operator);
      if (needsValue && !condition.value) {
        throw new BadRequestException(
          `Condition on "${condition.field}" uses operator "${operator}", which requires a value`,
        );
      }

      const field = builtIns.get(condition.field);
      // An unknown field is allowed — it may be a tenant custom field — but a
      // *known* field must be used with an operator that makes sense for it.
      if (field) {
        const allowed = operatorsForFieldType(field.type);
        if (!allowed.includes(operator)) {
          throw new BadRequestException(
            `Operator "${operator}" cannot be used on ${field.type} field "${condition.field}"`,
          );
        }
      }
    }
  }

  /** A rule must actually name a target, or matching it achieves nothing. */
  private validateActions(actions: {
    userId?: string | null;
    groupIds?: string[];
    strategy?: string | null;
  }): void {
    const hasUser = Boolean(actions.userId);
    const hasGroups = (actions.groupIds ?? []).length > 0;
    if (!hasUser && !hasGroups && actions.strategy !== 'manual') {
      throw new BadRequestException(
        'A rule must pin a user, name at least one team, or use the manual strategy',
      );
    }
    if (hasUser && hasGroups) {
      // Not an error — the team becomes the filing group for the pinned user —
      // but a chain of several teams alongside a pinned user is meaningless.
      if ((actions.groupIds ?? []).length > 1) {
        throw new BadRequestException(
          'A rule that pins a user may name at most one team (the filing group)',
        );
      }
    }
  }

  /**
   * A rule's `groupIds` must belong to this tenant. At runtime the group
   * lookup is already tenant-scoped by `tenantFilterPlugin`, so a foreign or
   * dangling id just resolves to zero candidates rather than leaking anything
   * — but that failure is silent and confusing. Reject it here instead, the
   * same way `ChannelSupportService.assertGroupsInTenant` does for channel
   * support pools.
   */
  private async assertGroupsInTenant(
    tenantId: string,
    groupIds: string[],
  ): Promise<void> {
    if (groupIds.length === 0) return;

    const objectIds = groupIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    const found = await this.groupModel
      .find({ _id: { $in: objectIds }, tenantId: new Types.ObjectId(tenantId) })
      .select('_id')
      .lean()
      .exec();

    const foundSet = new Set(found.map((g: any) => String(g._id)));
    const missing = groupIds.filter((id) => !foundSet.has(String(id)));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Team(s) not found in this workspace: ${missing.join(', ')}`,
      );
    }
  }

  private async assertUsersInTenant(
    tenantId: string,
    userIds: Array<string | null | undefined>,
  ): Promise<void> {
    const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return;
    const objectIds = ids
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    const tenantObjectId = Types.ObjectId.isValid(tenantId)
      ? new Types.ObjectId(tenantId)
      : tenantId;
    const found = await this.connection
      .collection('users')
      .find({
        _id: { $in: objectIds },
        'tenants.tenantId': tenantObjectId,
      })
      .project({ _id: 1 })
      .toArray();
    const foundSet = new Set(found.map((user) => String(user._id)));
    const missing = ids.filter((id) => !foundSet.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `User(s) are not members of this workspace: ${missing.join(', ')}`,
      );
    }
  }

  async listRules(objectType?: string) {
    const tenantId = this.tenantId;
    return this.rules.findAll(
      tenantId,
      objectType ? this.objectTypeOf(objectType) : undefined,
    );
  }

  async createRule(dto: CreateAssignmentRuleDto) {
    const tenantId = this.tenantId;
    const objectType = this.objectTypeOf(dto.objectType);
    this.validateConditions(objectType, dto.conditions ?? []);
    this.validateActions(dto.actions ?? {});
    await this.assertGroupsInTenant(tenantId, dto.actions?.groupIds ?? []);
    await this.assertUsersInTenant(tenantId, [dto.actions?.userId]);

    const priority =
      dto.priority ?? (await this.rules.nextPriority(tenantId, objectType));

    try {
      const rule = await this.rules.create(tenantId, {
        objectType,
        name: dto.name,
        description: dto.description ?? null,
        priority,
        matchType: dto.matchType ?? 'all',
        conditions: (dto.conditions ?? []).map((c) => ({
          field: c.field,
          operator: c.operator,
          value: c.value ?? '',
        })),
        actions: {
          userId: dto.actions.userId ?? null,
          groupIds: dto.actions.groupIds ?? [],
          strategy: dto.actions.strategy ?? null,
          requiredSkills: dto.actions.requiredSkills ?? [],
        },
        enabled: dto.enabled ?? true,
      });
      await this.evaluator.invalidate(tenantId, objectType);
      return rule;
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException(
          `A ${objectType} rule named "${dto.name}" already exists`,
        );
      }
      throw err;
    }
  }

  async updateRule(id: string, dto: UpdateAssignmentRuleDto) {
    const tenantId = this.tenantId;
    const existing = await this.rules.findById(tenantId, id);
    if (!existing) throw new NotFoundException('Assignment rule not found');

    const objectType = dto.objectType
      ? this.objectTypeOf(dto.objectType)
      : existing.objectType;

    if (dto.conditions) this.validateConditions(objectType, dto.conditions);
    if (dto.actions) {
      this.validateActions({
        userId: dto.actions.userId ?? existing.actions.userId,
        groupIds: dto.actions.groupIds ?? existing.actions.groupIds,
        strategy: dto.actions.strategy ?? existing.actions.strategy,
      });
      await this.assertGroupsInTenant(
        tenantId,
        dto.actions.groupIds ?? existing.actions.groupIds,
      );
      await this.assertUsersInTenant(tenantId, [
        dto.actions.userId ?? existing.actions.userId,
      ]);
    }

    const patch: Record<string, unknown> = {};
    if (dto.objectType !== undefined) patch.objectType = objectType;
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.priority !== undefined) patch.priority = dto.priority;
    if (dto.matchType !== undefined) patch.matchType = dto.matchType;
    if (dto.conditions !== undefined) {
      patch.conditions = dto.conditions.map((c) => ({
        field: c.field,
        operator: c.operator,
        value: c.value ?? '',
      }));
    }
    if (dto.actions !== undefined) {
      patch.actions = {
        userId: dto.actions.userId ?? null,
        groupIds: dto.actions.groupIds ?? [],
        strategy: dto.actions.strategy ?? null,
        requiredSkills: dto.actions.requiredSkills ?? [],
      };
    }
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;

    const rule = await this.rules.update(tenantId, id, patch);
    // Invalidate both, in case the rule moved between objectTypes.
    await this.evaluator.invalidate(tenantId, existing.objectType);
    if (objectType !== existing.objectType) {
      await this.evaluator.invalidate(tenantId, objectType);
    }
    return rule;
  }

  async deleteRule(id: string) {
    const tenantId = this.tenantId;
    const existing = await this.rules.findById(tenantId, id);
    if (!existing) throw new NotFoundException('Assignment rule not found');
    await this.rules.delete(tenantId, id);
    await this.evaluator.invalidate(tenantId, existing.objectType);
  }

  async reorderRules(objectType: string, orderedIds: string[]) {
    const tenantId = this.tenantId;
    const type = this.objectTypeOf(objectType);
    await this.rules.reorder(tenantId, type, orderedIds);
    await this.evaluator.invalidate(tenantId, type);
    return this.rules.findAll(tenantId, type);
  }

  async getSettings(objectType: string) {
    return this.config.get(this.tenantId, this.objectTypeOf(objectType));
  }

  async getAllSettings() {
    const tenantId = this.tenantId;
    const types = builtInObjectTypes();
    const entries = await Promise.all(
      types.map(
        async (objectType) =>
          [objectType, await this.config.get(tenantId, objectType)] as const,
      ),
    );
    return Object.fromEntries(entries);
  }

  async updateSettings(objectType: string, dto: UpdateAssignmentSettingDto) {
    const type = this.objectTypeOf(objectType);
    await this.assertGroupsInTenant(
      this.tenantId,
      dto.defaultGroupId ? [dto.defaultGroupId] : [],
    );
    await this.assertUsersInTenant(this.tenantId, [dto.fallbackOwnerId]);
    const patch: Record<string, unknown> = { ...dto };
    // An explicit null clears the reference; undefined must not overwrite it.
    for (const key of Object.keys(patch)) {
      if (patch[key] === undefined) delete patch[key];
    }
    return this.config.upsert(this.tenantId, type, patch);
  }

  // Fields (UI metadata)

  fieldsFor(objectType: string) {
    const type = this.objectTypeOf(objectType);
    return builtInFieldsFor(type).map((field) => ({
      ...field,
      operators: operatorsForFieldType(field.type),
    }));
  }

  // Skills

  private toSkillView(doc: any): AssignmentSkillView {
    return {
      id: String(doc._id),
      name: doc.name,
      apiName: doc.apiName,
      category: doc.category ?? null,
      description: doc.description ?? null,
    };
  }

  async listSkills(): Promise<AssignmentSkillView[]> {
    const docs = await this.skillModel
      .find({ tenantId: this.tenantId })
      .sort({ category: 1, name: 1 })
      .lean()
      .exec();
    return docs.map((d) => this.toSkillView(d));
  }

  async createSkill(
    dto: CreateAssignmentSkillDto,
  ): Promise<AssignmentSkillView> {
    const apiName = toSkillApiName(dto.name);
    if (!apiName) {
      throw new BadRequestException(
        'Skill name must contain at least one letter or digit',
      );
    }
    try {
      const created = await this.skillModel.create({
        tenantId: this.tenantId,
        name: dto.name.trim(),
        apiName,
        category: dto.category ?? null,
        description: dto.description ?? null,
      });
      return this.toSkillView(created.toObject());
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException(
          `A skill with apiName "${apiName}" already exists`,
        );
      }
      throw err;
    }
  }

  /**
   * `apiName` is intentionally NOT updatable: it is stored on every user and
   * referenced by every rule, so renaming it would silently unmatch both.
   * Display name and category are free to change.
   */
  async updateSkill(
    id: string,
    dto: UpdateAssignmentSkillDto,
  ): Promise<AssignmentSkillView> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Skill not found');
    }
    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.category !== undefined) patch.category = dto.category;
    if (dto.description !== undefined) patch.description = dto.description;

    const skill = await this.skillModel
      .findOneAndUpdate(
        { _id: id, tenantId: this.tenantId },
        { $set: patch },
        { new: true },
      )
      .lean()
      .exec();
    if (!skill) throw new NotFoundException('Skill not found');
    return this.toSkillView(skill);
  }

  async deleteSkill(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Skill not found');
    }
    const tenantId = this.tenantId;
    const skill = await this.skillModel
      .findOne({ _id: id, tenantId })
      .lean()
      .exec();
    if (!skill) throw new NotFoundException('Skill not found');

    // Refuse to delete a skill a rule still requires: the rule would keep
    // filtering on a vocabulary entry nothing can satisfy, and every decision
    // would quietly fall back to the unfiltered pool.
    const referencing = await this.rules.findAll(tenantId);
    const users = referencing.filter((rule) =>
      rule.actions.requiredSkills.includes(skill.apiName),
    );
    if (users.length > 0) {
      throw new ConflictException(
        `Skill "${skill.name}" is required by ${users.length} rule(s): ${users
          .map((r) => r.name)
          .join(', ')}`,
      );
    }

    await this.skillModel.deleteOne({ _id: id, tenantId }).exec();
  }

  // Dry run

  /**
   * Simulate a decision with no side effects: no reservation, no write, no audit
   * row. Returns the full rule-by-rule trace so an admin can see *why* a rule
   * did or did not match, not just which one won.
   */
  async dryRun(dto: DryRunDto) {
    const objectType = this.objectTypeOf(dto.objectType);
    const decision = await this.core.assign({
      tenantId: this.tenantId,
      objectType,
      attributes: dto.attributes,
      scopeId: dto.scopeId ?? null,
      dryRun: true,
      explain: true,
      source: 'api',
    });
    return { ...decision, isDryRun: true };
  }

  async searchAudit(query: {
    objectType?: string;
    entityId?: string;
    assigneeId?: string;
    outcome?: string;
    source?: string;
    ruleId?: string;
    limit?: number;
  }) {
    const requestedType = query.objectType
      ? this.objectTypeOf(query.objectType)
      : undefined;
    return this.audit.search(
      this.tenantId,
      {
        objectType: requestedType,
        entityId: query.entityId,
        assigneeId: query.assigneeId,
        outcome: query.outcome as AssignmentOutcome | undefined,
        source: query.source as AssignmentSource | undefined,
        ruleId: query.ruleId,
        visibility: this.auditVisibility(requestedType),
      },
      query.limit ?? 50,
    );
  }

  async auditForEntity(objectType: string, entityId: string) {
    const type = this.objectTypeOf(objectType);
    const visible = await this.audit.search(
      this.tenantId,
      {
        objectType: type,
        entityId,
        visibility: this.auditVisibility(type),
      },
      50,
    );
    return visible.reverse();
  }

  async listQueue(query: {
    objectType?: string;
    groupId?: string;
    limit?: number;
  }): Promise<AssignmentQueueItemView[]> {
    const filter: Record<string, unknown> = {
      tenantId: this.tenantId,
      status: 'queued',
    };
    const visibleGroups = this.cls.get<string[] | null>('visibleGroupIds');
    if (visibleGroups !== null) {
      filter.groupId = { $in: visibleGroups ?? [] };
    }
    if (query.objectType) {
      filter.objectType = this.objectTypeOf(query.objectType);
    }
    if (query.groupId) {
      if (!Types.ObjectId.isValid(query.groupId)) {
        throw new BadRequestException('Invalid groupId');
      }
      if (visibleGroups !== null && !visibleGroups?.includes(query.groupId)) {
        return [];
      }
      filter.groupId = new Types.ObjectId(query.groupId);
    }
    const limit = Math.max(1, Math.min(query.limit ?? 50, 200));
    return this.queueItemModel
      .find(filter)
      .sort({ priority: -1, slaDueAt: 1, queuedAt: 1, _id: 1 })
      .limit(limit)
      .lean<AssignmentQueueItemView[]>()
      .exec();
  }

  private auditVisibility(objectType?: AssignmentObjectType) {
    const types = objectType ? [objectType] : builtInObjectTypes();
    const byModule =
      this.cls.get<
        Record<
          string,
          { ownerIds: string[] | null; orgUnitIds: string[] | null }
        >
      >('dataVisibilityByModule') ?? {};
    const baseOwnerIds = this.cls.get<string[] | null>('visibleOwnerIds');
    const groupIds = this.cls.get<string[] | null>('visibleGroupIds');
    return types.map((type) => {
      const moduleOwnerIds = byModule[type]?.ownerIds;
      return {
        objectType: type,
        ownerIds:
          moduleOwnerIds !== undefined
            ? moduleOwnerIds
            : baseOwnerIds !== undefined
              ? baseOwnerIds
              : [],
        groupIds: groupIds !== undefined ? groupIds : [],
      };
    });
  }
}

/** Kept local so the DTO module stays the only importer of the enum array. */
function builtInObjectTypes(): AssignmentObjectType[] {
  return [
    'Lead',
    'Contact',
    'Account',
    'Ticket',
    'Task',
    'Deal',
    'Conversation',
  ];
}
