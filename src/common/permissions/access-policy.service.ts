import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AccessPolicySchemaClass,
  AccessPolicyDocument,
} from './access-policy.schema';
import {
  AbacContext,
  AbacPolicy,
  AbacCondition,
  AbacOperator,
  PolicyEffect,
  evaluatePolicies,
} from './abac.evaluator';
import { AuthzAuditService } from '../authz-audit/authz-audit.service';

const VALID_OPERATORS: AbacOperator[] = [
  'eq',
  'ne',
  'in',
  'nin',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'exists',
];

export interface UpsertAccessPolicyInput {
  name: string;
  description?: string;
  resource: string;
  action: string;
  effect: PolicyEffect;
  conditions: AbacCondition[];
  active?: boolean;
  priority?: number;
}

/**
 * AccessPolicyService — CRUD + evaluation of tenant ABAC policies.
 *
 * `evaluate()` is the PDP hook: it loads the active policies matching a
 * (resource, action) — including '*' wildcards — and returns the combined
 * deny-overrides effect (or null = no opinion). It never throws on the hot
 * path: a lookup failure degrades to null (fall back to RBAC), it does not
 * fail the request open OR closed by accident.
 */
@Injectable()
export class AccessPolicyService {
  private readonly logger = new Logger(AccessPolicyService.name);

  constructor(
    @InjectModel(AccessPolicySchemaClass.name)
    private readonly model: Model<AccessPolicyDocument>,
    private readonly audit: AuthzAuditService,
  ) {}

  // ── Evaluation (hot path) ──────────────────────────────────────────────────

  async evaluate(
    tenantId: string,
    resource: string,
    action: string,
    ctx: AbacContext,
  ): Promise<PolicyEffect | null> {
    try {
      const policies = await this.model
        .find({
          tenantId,
          active: true,
          resource: { $in: [resource, '*'] },
          action: { $in: [action, '*'] },
        })
        .sort({ priority: 1, _id: 1 })
        .lean()
        .exec();

      if (policies.length === 0) return null;

      const asAbac: AbacPolicy[] = policies.map((p) => ({
        effect: p.effect,
        conditions: Array.isArray(p.conditions) ? p.conditions : [],
      }));
      return evaluatePolicies(asAbac, ctx);
    } catch (error) {
      this.logger.warn(
        `ABAC evaluate failed for ${tenantId} ${resource}:${action}; falling back to RBAC: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  findAll(tenantId: string): Promise<AccessPolicyDocument[]> {
    return this.model
      .find({ tenantId })
      .sort({ resource: 1, action: 1, priority: 1 })
      .lean()
      .exec() as any;
  }

  async create(
    tenantId: string,
    input: UpsertAccessPolicyInput,
  ): Promise<AccessPolicyDocument> {
    this.validateConditions(input.conditions);
    const doc = await this.model.create({ tenantId, ...input });
    void this.audit.record({
      category: 'ROLE',
      action: 'create',
      targetType: 'access_policy',
      targetId: String(doc._id),
      summary: `created ABAC policy "${input.name}" (${input.effect} ${input.resource}:${input.action})`,
      after: { effect: input.effect, conditions: input.conditions },
    });
    return doc;
  }

  async update(
    id: string,
    tenantId: string,
    input: Partial<UpsertAccessPolicyInput>,
  ): Promise<AccessPolicyDocument> {
    if (input.conditions) this.validateConditions(input.conditions);
    const existing = await this.model.findOne({ _id: id, tenantId }).exec();
    if (!existing) throw new NotFoundException(`Access policy ${id} not found`);
    const before = {
      effect: existing.effect,
      conditions: existing.conditions,
      active: existing.active,
    };
    Object.assign(existing, input);
    const saved = await existing.save();
    void this.audit.record({
      category: 'ROLE',
      action: 'update',
      targetType: 'access_policy',
      targetId: String(saved._id),
      summary: `updated ABAC policy "${saved.name}"`,
      before,
      after: {
        effect: saved.effect,
        conditions: saved.conditions,
        active: saved.active,
      },
    });
    return saved;
  }

  async remove(id: string, tenantId: string): Promise<void> {
    const existing = await this.model.findOne({ _id: id, tenantId }).exec();
    if (!existing) throw new NotFoundException(`Access policy ${id} not found`);
    await existing.deleteOne();
    void this.audit.record({
      category: 'ROLE',
      action: 'delete',
      targetType: 'access_policy',
      targetId: String(id),
      summary: `deleted ABAC policy "${existing.name}"`,
      before: { effect: existing.effect, conditions: existing.conditions },
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private validateConditions(conditions: AbacCondition[]): void {
    if (!Array.isArray(conditions)) {
      throw new BadRequestException('conditions must be an array');
    }
    for (const c of conditions) {
      if (!c?.attribute || typeof c.attribute !== 'string') {
        throw new BadRequestException('each condition needs an attribute path');
      }
      if (!VALID_OPERATORS.includes(c.operator)) {
        throw new BadRequestException(`unknown operator: ${c.operator}`);
      }
      if (c.value === undefined && c.valueAttribute === undefined) {
        // `exists` uses a boolean value; everything else needs a comparand.
        if (c.operator !== 'exists') {
          throw new BadRequestException(
            `condition on "${c.attribute}" needs value or valueAttribute`,
          );
        }
      }
    }
  }
}
