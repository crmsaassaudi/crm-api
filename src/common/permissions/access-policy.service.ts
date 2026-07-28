import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
  Optional,
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
  policyApplies,
} from './abac.evaluator';
import { AuthzAuditService } from '../authz-audit/authz-audit.service';
import { AccessPolicy } from './domain/access-policy';
import { AccessPolicyMapper } from './mappers/access-policy.mapper';
import { RedisService } from '../../redis/redis.service';
import { ClsService } from 'nestjs-cls';
import { AbacMongoFilter, compileAbacDenyFilter } from './abac-query.compiler';

type CachedAccessPolicy = Pick<
  AccessPolicySchemaClass,
  'resource' | 'action' | 'effect' | 'conditions' | 'priority'
>;

const POLICY_CACHE_TTL_SECONDS = 60;

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
    @Optional() private readonly redis?: RedisService,
    @Optional() private readonly cls?: ClsService,
  ) {}

  // ── Evaluation (hot path) ──────────────────────────────────────────────────

  async evaluate(
    tenantId: string,
    resource: string,
    action: string,
    ctx: AbacContext,
  ): Promise<PolicyEffect | null> {
    try {
      const policies = (await this.loadActivePolicies(tenantId)).filter(
        (policy) =>
          [resource, '*'].includes(policy.resource) &&
          [action, '*'].includes(policy.action),
      );

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

  /**
   * Evaluate only policies that can be decided without a concrete record.
   *
   * This is the collection/action PEP used for list, create, import/export,
   * reports and bulk actions. Resource-dependent policies are deliberately
   * excluded here and remain the responsibility of record evaluation/query
   * compilation; treating a missing resource attribute as a decision would
   * either bypass a deny or incorrectly block an entire collection.
   */
  async evaluateActionContext(
    tenantId: string,
    resource: string,
    action: string,
    ctx: AbacContext,
  ): Promise<PolicyEffect | null> {
    try {
      const policies = (await this.loadActivePolicies(tenantId)).filter(
        (policy) =>
          [resource, '*'].includes(policy.resource) &&
          [action, '*'].includes(policy.action),
      );

      const actionPolicies: AbacPolicy[] = policies
        .filter((policy) =>
          (Array.isArray(policy.conditions) ? policy.conditions : []).every(
            (condition) =>
              !condition.attribute?.startsWith('resource.') &&
              !condition.valueAttribute?.startsWith('resource.'),
          ),
        )
        .map((policy) => ({
          effect: policy.effect,
          conditions: Array.isArray(policy.conditions) ? policy.conditions : [],
        }));

      return actionPolicies.length > 0
        ? evaluatePolicies(actionPolicies, ctx)
        : null;
    } catch (error) {
      this.logger.error(
        `Action ABAC evaluate FAILED for ${tenantId} ${resource}:${action} — denying (fail-closed): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ServiceUnavailableException(
        'Authorization policy store unavailable',
      );
    }
  }

  /**
   * Produce the row-subtraction predicate for collection reads. This shares the
   * same cached policy snapshot as record evaluation, so detail and list paths
   * cannot observe different policy versions during a request.
   */
  async compileResourceDenyFilter(
    tenantId: string,
    resource: string,
    action: string,
    ctx: AbacContext,
  ): Promise<AbacMongoFilter | null> {
    try {
      const policies = (await this.loadActivePolicies(tenantId))
        .filter(
          (policy) =>
            [resource, '*'].includes(policy.resource) &&
            [action, '*'].includes(policy.action),
        )
        .map<AbacPolicy>((policy) => ({
          effect: policy.effect,
          conditions: Array.isArray(policy.conditions) ? policy.conditions : [],
        }));
      return compileAbacDenyFilter(policies, ctx);
    } catch (error) {
      this.logger.error(
        `ABAC query compilation FAILED for ${tenantId} ${resource}:${action} — denying (fail-closed): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (error instanceof ServiceUnavailableException) throw error;
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
    const snapshot = this.policySnapshot(input);
    const doc = await this.model.create({
      tenantId,
      ...input,
      revision: 1,
      versions: [
        {
          revision: 1,
          snapshot,
          publishedAt: new Date(),
          publishedById: this.actorId(),
          sourceRevision: null,
        },
      ],
    });
    await this.invalidatePolicyBundle(tenantId);
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
    if (!Array.isArray(existing.versions) || existing.versions.length === 0) {
      existing.versions = [
        {
          revision: existing.revision ?? 1,
          snapshot: this.policySnapshot(existing),
          publishedAt: (existing as any).createdAt ?? new Date(),
          publishedById: 'legacy',
          sourceRevision: null,
        },
      ];
    }
    Object.assign(existing, input);
    existing.revision = (existing.revision ?? 1) + 1;
    existing.versions.push({
      revision: existing.revision,
      snapshot: this.policySnapshot(existing),
      publishedAt: new Date(),
      publishedById: this.actorId(),
      sourceRevision: null,
    });
    const saved = await existing.save();
    await this.invalidatePolicyBundle(tenantId);
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
    await this.invalidatePolicyBundle(tenantId);
    void this.audit.record({
      category: 'ROLE',
      action: 'delete',
      targetType: 'access_policy',
      targetId: String(id),
      summary: `deleted ABAC policy "${existing.name}"`,
      before: { effect: existing.effect, conditions: existing.conditions },
    });
  }

  async listVersions(id: string, tenantId: string) {
    const policy = await this.model
      .findOne({ _id: id, tenantId })
      .select({ versions: 1, revision: 1 })
      .lean()
      .exec();
    if (!policy) throw new NotFoundException(`Access policy ${id} not found`);
    return {
      currentRevision: policy.revision ?? 1,
      versions: policy.versions ?? [],
    };
  }

  async rollback(
    id: string,
    tenantId: string,
    sourceRevision: number,
  ): Promise<AccessPolicy> {
    const policy = await this.model.findOne({ _id: id, tenantId }).exec();
    if (!policy) throw new NotFoundException(`Access policy ${id} not found`);
    const source = (policy.versions ?? []).find(
      (entry) => entry.revision === sourceRevision,
    );
    if (!source) {
      throw new NotFoundException(`Policy revision ${sourceRevision} not found`);
    }
    const snapshot = source.snapshot as Partial<UpsertAccessPolicyInput>;
    this.validateConditions(snapshot.conditions ?? []);
    Object.assign(policy, snapshot);
    policy.revision = (policy.revision ?? 1) + 1;
    policy.versions.push({
      revision: policy.revision,
      snapshot: this.policySnapshot(policy),
      publishedAt: new Date(),
      publishedById: this.actorId(),
      sourceRevision,
    });
    const saved = await policy.save();
    await this.invalidatePolicyBundle(tenantId);
    void this.audit.record({
      category: 'ROLE',
      action: 'update',
      targetType: 'access_policy',
      targetId: String(saved._id),
      summary: `rolled back ABAC policy to revision ${sourceRevision} as revision ${saved.revision}`,
      after: { sourceRevision, revision: saved.revision },
    });
    return AccessPolicyMapper.toDomain(saved);
  }

  simulate(
    input: UpsertAccessPolicyInput,
    context: AbacContext,
  ): { applies: boolean; effect: PolicyEffect | null } {
    this.validateConditions(input.conditions);
    const applies = policyApplies(
      { effect: input.effect, conditions: input.conditions },
      context,
    );
    return { applies, effect: applies ? input.effect : null };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private policyVersionKey(tenantId: string): string {
    return `authz:policy:${tenantId}:version`;
  }

  private actorId(): string {
    return String(this.cls?.get<string>('userId') ?? 'system');
  }

  private policySnapshot(
    input: Partial<UpsertAccessPolicyInput> & Record<string, any>,
  ): Record<string, unknown> {
    return {
      name: input.name,
      description: input.description ?? '',
      resource: input.resource,
      action: input.action,
      effect: input.effect,
      conditions: Array.isArray(input.conditions) ? input.conditions : [],
      active: input.active ?? true,
      priority: input.priority ?? 100,
    };
  }

  private policyBundleKey(tenantId: string, version: string): string {
    return `authz:policy:${tenantId}:v${version}:active`;
  }

  /**
   * Cache the complete active tenant bundle so wildcard matching and both
   * record/action evaluation share one snapshot. Redis is only an optimization:
   * an unavailable cache falls back to the authoritative policy store.
   */
  private async loadActivePolicies(
    tenantId: string,
  ): Promise<CachedAccessPolicy[]> {
    if (this.redis) {
      try {
        const client = this.redis.getClient();
        const versionKey = this.policyVersionKey(tenantId);
        let version = await client.get(versionKey);
        if (version === null) {
          await client.set(versionKey, '1', 'NX');
          version = (await client.get(versionKey)) ?? '1';
        }

        const bundleKey = this.policyBundleKey(tenantId, version);
        const cached = await this.redis.get<CachedAccessPolicy[]>(bundleKey);
        if (Array.isArray(cached)) return cached;

        const policies = await this.readActivePolicies(tenantId);
        try {
          await this.redis.set(bundleKey, policies, POLICY_CACHE_TTL_SECONDS);
        } catch (error) {
          this.logger.warn(
            `Could not cache ABAC bundle for ${tenantId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        return policies;
      } catch (error) {
        this.logger.warn(
          `ABAC cache unavailable for ${tenantId}; reading policy store: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return this.readActivePolicies(tenantId);
  }

  private async readActivePolicies(
    tenantId: string,
  ): Promise<CachedAccessPolicy[]> {
    return this.model
      .find({ tenantId, active: true })
      .sort({ priority: 1, _id: 1 })
      .lean()
      .exec() as unknown as Promise<CachedAccessPolicy[]>;
  }

  /**
   * INCR makes invalidation visible across every API instance without key
   * scans. During a Redis outage evaluators also miss Redis and use Mongo.
   */
  private async invalidatePolicyBundle(tenantId: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.getClient().incr(this.policyVersionKey(tenantId));
    } catch (error) {
      this.logger.error(
        `ABAC cache invalidation failed for ${tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ServiceUnavailableException(
        'Policy saved but authorization cache invalidation failed',
      );
    }
  }

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
