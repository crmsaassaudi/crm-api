import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
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
import { AccessPolicy } from './domain/access-policy';
import { AccessPolicyMapper } from './mappers/access-policy.mapper';

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
 * deny-overrides effect, or null when no policy matches ("no opinion", defer to
 * the RBAC grant).
 *
 * It FAILS CLOSED: if the policy store cannot be read, it throws rather than
 * returning null. In a deny-based model, degrading to "no opinion" on error is
 * the same as disabling every restriction, which is the opposite of safe (H-04).
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
      // FAIL CLOSED (H-04).
      //
      // This used to return null, which the PDP reads as "no opinion" and
      // therefore allows. In a deny-based policy model that inverts the
      // security property under exactly the conditions where it matters most:
      // a Mongo timeout disabled every deny policy tenant-wide while the
      // service reported healthy.
      //
      // Throwing surfaces as a 500 rather than a silent authorization
      // downgrade. An outage is the correct failure mode for a policy store
      // the decision depends on.
      this.logger.error(
        `ABAC evaluate FAILED for ${tenantId} ${resource}:${action} — denying (fail-closed): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ServiceUnavailableException(
        'Authorization policy store unavailable',
      );
    }
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  async findAll(tenantId: string): Promise<AccessPolicy[]> {
    const rows = await this.model
      .find({ tenantId })
      .sort({ resource: 1, action: 1, priority: 1 })
      .lean()
      .exec();
    return AccessPolicyMapper.toDomainList(rows);
  }

  async create(
    tenantId: string,
    input: UpsertAccessPolicyInput,
  ): Promise<AccessPolicy> {
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
    return AccessPolicyMapper.toDomain(doc);
  }

  async update(
    id: string,
    tenantId: string,
    input: Partial<UpsertAccessPolicyInput>,
  ): Promise<AccessPolicy> {
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
    return AccessPolicyMapper.toDomain(saved);
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
      this.validateAttributePath(c.attribute);
      if (c.valueAttribute) this.validateAttributePath(c.valueAttribute);
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
      if (
        ['in', 'nin'].includes(c.operator) &&
        c.valueAttribute === undefined &&
        !Array.isArray(c.value)
      ) {
        // `in`/`nin` against a non-array is not a subtle bug: `in` never matches
        // and `nin` ALWAYS matches, so a malformed `nin` deny blocks everyone.
        throw new BadRequestException(
          `operator "${c.operator}" on "${c.attribute}" requires an array value`,
        );
      }
    }
  }

  /**
   * Attribute paths address the evaluation context, and nothing else.
   *
   * The evaluator walks the path with plain property access, so an unrestricted
   * path can reach the prototype chain (`subject.constructor.…`). Values are
   * only ever compared, never invoked, so this was not exploitable — but an
   * authorization input should not accept anything it cannot mean (L-02).
   */
  private validateAttributePath(path: string): void {
    const [root, ...rest] = path.split('.');
    if (!['subject', 'resource', 'env'].includes(root)) {
      throw new BadRequestException(
        `attribute must start with subject/resource/env, got "${path}"`,
      );
    }
    const forbidden = ['__proto__', 'constructor', 'prototype'];
    if (rest.some((segment) => forbidden.includes(segment) || segment === '')) {
      throw new BadRequestException(`invalid attribute path "${path}"`);
    }
  }
}
