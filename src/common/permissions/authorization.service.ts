import { Injectable, Logger, Optional } from '@nestjs/common';
import { PlatformRoleEnum } from '../../roles/platform-role.enum';
import {
  AuthzPermissionCacheService,
  AuthzPermissionCheckResult,
} from './authz-permission-cache.service';
import { ObjectAclService } from './object-acl.service';
import { AccessPolicyService } from './access-policy.service';
import { PermissionRuleMetadata } from './permission.decorator';
import { AuthorizationContextFactory } from './authorization-context.factory';
import { AuthzAuditService } from '../authz-audit/authz-audit.service';

export interface AuthzActionDecision
  extends Partial<AuthzPermissionCheckResult> {
  allowed: boolean;
  /** True when granted via a verified platform SUPER_ADMIN bypass. */
  superAdmin?: boolean;
  /** Mongo predicate that subtracts rows denied by resource ABAC policies. */
  resourceFilter?: Record<string, unknown> | null;
}

export interface CanPerformActionParams {
  rule: PermissionRuleMetadata;
  rawUserId: string;
  tenantHint?: string;
  /** Raw JWT/Keycloak payload — used only to detect a super-admin claim. */
  claims?: any;
  /** Trusted request environment resolved by server middleware. */
  env?: Record<string, unknown>;
}

export interface CanAccessRecordParams {
  tenantId: string;
  userId: string;
  action: string;
  resource: string;
  resourceId: string;
  groupIds?: string[];
  /** Actor kind for ABAC subject conditions (defaults to 'user'). */
  principalType?: string;
  /** The record being acted on — enables resource.* ABAC conditions. */
  record?: Record<string, unknown>;
  /** Extra subject attributes for ABAC (e.g. roleIds, department). */
  subject?: Record<string, unknown>;
  /** Extra environment attributes for ABAC (e.g. ip). `now` is injected. */
  env?: Record<string, unknown>;
}

/**
 * AuthorizationService — the single Policy Decision Point (PDP) for the app.
 *
 * It unifies the previously-scattered decision paths behind one facade:
 *   1. RBAC action gating          → AuthzPermissionCacheService (effective set)
 *   2. Platform SUPER_ADMIN bypass → claim + server-side DB confirmation (C5)
 *   3. Object-level ACL            → ObjectAclService (deny-overrides)
 *   4. Data-scope (row visibility) → CLS `visibleOwnerIds` (set by interceptor)
 *
 * Guards are thin adapters over this service; business code should call it
 * directly for record-level checks instead of re-implementing the logic.
 * Precedence is deny-overrides across every layer.
 */
@Injectable()
export class AuthorizationService {
  private readonly logger = new Logger(AuthorizationService.name);

  constructor(
    private readonly cache: AuthzPermissionCacheService,
    private readonly objectAcl: ObjectAclService,
    private readonly accessPolicy: AccessPolicyService,
    private readonly contextFactory: AuthorizationContextFactory,
    @Optional() private readonly decisionAudit?: AuthzAuditService,
  ) {}

  /** Does the (signed) token carry a platform SUPER_ADMIN role claim? */
  hasSuperAdminClaim(claims: any): boolean {
    const roles = [
      ...(claims?.realm_access?.roles ?? []),
      ...Object.values(claims?.resource_access ?? {}).flatMap(
        (resource: any) => resource?.roles ?? [],
      ),
      ...(claims?.roles ?? []),
    ].map(String);
    return roles.includes(PlatformRoleEnum.SUPER_ADMIN);
  }

  /**
   * Platform super-admin requires BOTH a signed claim AND a DB-confirmed
   * platformRole === SUPER_ADMIN (C5) — a claim alone must never grant it.
   */
  async isSuperAdmin(rawUserId: string, claims: any): Promise<boolean> {
    if (!this.hasSuperAdminClaim(claims)) return false;
    return this.cache.isPlatformSuperAdmin(rawUserId);
  }

  /**
   * RBAC action gating (resource-level). Short-circuits to allow for a
   * verified platform super-admin; otherwise delegates to the cached
   * effective-permission set.
   */
  async canPerformAction(
    params: CanPerformActionParams,
  ): Promise<AuthzActionDecision> {
    if (await this.isSuperAdmin(params.rawUserId, params.claims)) {
      this.recordDecision({
        tenantId: params.tenantHint,
        userId: params.rawUserId,
        action: params.rule.action,
        resource: params.rule.resource,
        allowed: true,
        reason: 'platform_super_admin',
        grantSource: 'platform_role',
      });
      return { allowed: true, superAdmin: true };
    }
    const result = await this.cache.canAccess({
      rawUserId: params.rawUserId,
      tenantHint: params.tenantHint,
      rule: params.rule,
    });
    if (!result.allowed || !result.tenantId || !result.userId) {
      this.recordDecision({
        tenantId: result.tenantId ?? params.tenantHint,
        userId: result.userId ?? params.rawUserId,
        action: params.rule.action,
        resource: params.rule.resource,
        allowed: false,
        reason: result.denyReason ?? 'rbac_denied',
        grantSource: 'rbac',
      });
      return { ...result };
    }

    // Collection/action ABAC: enforce policies that depend only on trusted
    // subject/environment attributes. Resource-dependent policies are handled
    // later by canAccessRecord or by a query predicate compiler.
    const context = this.contextFactory.forAction(
      {
        userId: result.userId,
        tenantId: result.tenantId,
        principalType: params.claims?.principalType ?? 'user',
      },
      { attributes: params.env },
    );
    const effect = await this.accessPolicy.evaluateActionContext(
      result.tenantId,
      params.rule.resource,
      params.rule.action,
      context,
    );
    if (effect === 'deny') {
      this.recordDecision({
        tenantId: result.tenantId,
        userId: result.userId,
        action: params.rule.action,
        resource: params.rule.resource,
        allowed: false,
        reason: 'abac_action_denied',
        grantSource: 'abac',
      });
      return {
        ...result,
        allowed: false,
        denyReason: 'abac_action_denied',
      };
    }
    const resourceFilter =
      await this.accessPolicy.compileResourceDenyFilter(
        result.tenantId,
        params.rule.resource,
        params.rule.action,
        context,
      );
    this.recordDecision({
      tenantId: result.tenantId,
      userId: result.userId,
      action: params.rule.action,
      resource: params.rule.resource,
      allowed: true,
      reason: resourceFilter ? 'rbac_with_abac_filter' : 'rbac_granted',
      grantSource: resourceFilter ? 'rbac+abac' : 'rbac',
    });
    return { ...result, resourceFilter };
  }

  /**
   * Record-level decision (assumes the resource-level RBAC action gate has
   * already passed at the guard). Deny-overrides across two record-level
   * layers:
   *   1. Object-ACL   → explicit deny wins; explicit allow widens; null = defer
   *   2. ABAC policy  → attribute-conditioned deny wins; allow widens; null = defer
   * When neither layer objects, the resource-level authorization already
   * granted at the guard stands (return true).
   *
   * ABAC conditions can reference `subject.*` (actor), `resource.*` (the record,
   * when provided) and `env.*`. Without a loaded record, only subject/env
   * conditions can match — resource conditions simply do not hold.
   */
  async canAccessRecord(params: CanAccessRecordParams): Promise<boolean> {
    // Both record-level layers fail CLOSED (H-04): a store that cannot be read
    // must deny, never degrade to "no opinion" — which in a deny-overrides
    // model is indistinguishable from having no restrictions at all.
    let acl: boolean | null;
    try {
      acl = await this.objectAcl.can(
        params.tenantId,
        params.userId,
        params.action,
        params.resource,
        params.resourceId,
        params.groupIds ?? [],
      );
    } catch (error) {
      this.logger.error(
        `Object-ACL lookup failed for ${params.resource}/${params.resourceId} — denying (fail-closed): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
    if (acl === false) {
      this.recordRecordDecision(params, false, 'object_acl_denied', 'object_acl');
      return false;
    }

    const effect = await this.accessPolicy.evaluate(
      params.tenantId,
      params.resource,
      params.action,
      this.contextFactory.forRecord(
        {
          userId: params.userId,
          tenantId: params.tenantId,
          principalType: params.principalType,
          groupIds: params.groupIds,
          attributes: params.subject,
        } as any,
        params.resourceId,
        params.record,
        { attributes: params.env },
      ),
    );
    if (effect === 'deny') {
      this.recordRecordDecision(params, false, 'abac_record_denied', 'abac');
      return false;
    }

    // acl is true or null, ABAC is allow or null → access stands.
    this.recordRecordDecision(
      params,
      true,
      effect === 'allow'
        ? 'abac_record_allowed'
        : acl === true
          ? 'object_acl_allowed'
          : 'record_grant_stands',
      effect === 'allow' ? 'abac' : acl === true ? 'object_acl' : 'rbac',
    );
    return true;
  }

  private recordRecordDecision(
    params: CanAccessRecordParams,
    allowed: boolean,
    reason: string,
    grantSource: string,
  ): void {
    this.recordDecision({
      tenantId: params.tenantId,
      userId: params.userId,
      action: params.action,
      resource: params.resource,
      resourceId: params.resourceId,
      allowed,
      reason,
      grantSource,
    });
  }

  private recordDecision(input: {
    tenantId?: string;
    userId: string;
    action: string;
    resource: string;
    resourceId?: string;
    allowed: boolean;
    reason: string;
    grantSource: string;
  }): void {
    if (!this.decisionAudit || !input.tenantId) return;
    void this.decisionAudit.record({
      category: 'DECISION',
      action: input.allowed ? 'allow' : 'deny',
      tenantId: input.tenantId,
      actorId: input.userId,
      targetType: input.resource,
      targetId: input.resourceId ?? '*',
      summary: `${input.action} ${input.resource}: ${input.allowed ? 'allow' : 'deny'} (${input.reason})`,
      after: {
        subjectId: input.userId,
        action: input.action,
        resource: input.resource,
        resourceId: input.resourceId ?? null,
        result: input.allowed ? 'allow' : 'deny',
        reason: input.reason,
        grantSource: input.grantSource,
      },
    });
  }
}
