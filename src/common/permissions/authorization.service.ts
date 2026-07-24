import { Injectable, Logger } from '@nestjs/common';
import { PlatformRoleEnum } from '../../roles/platform-role.enum';
import {
  AuthzPermissionCacheService,
  AuthzPermissionCheckResult,
} from './authz-permission-cache.service';
import { ObjectAclService } from './object-acl.service';
import { AccessPolicyService } from './access-policy.service';
import { PermissionRuleMetadata } from './permission.decorator';

export interface AuthzActionDecision extends Partial<AuthzPermissionCheckResult> {
  allowed: boolean;
  /** True when granted via a verified platform SUPER_ADMIN bypass. */
  superAdmin?: boolean;
}

export interface CanPerformActionParams {
  rule: PermissionRuleMetadata;
  rawUserId: string;
  tenantHint?: string;
  /** Raw JWT/Keycloak payload — used only to detect a super-admin claim. */
  claims?: any;
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
      return { allowed: true, superAdmin: true };
    }
    const result = await this.cache.canAccess({
      rawUserId: params.rawUserId,
      tenantHint: params.tenantHint,
      rule: params.rule,
    });
    return { ...result };
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
    const acl = await this.objectAcl.can(
      params.tenantId,
      params.userId,
      params.action,
      params.resource,
      params.resourceId,
      params.groupIds ?? [],
    );
    if (acl === false) return false; // explicit ACL deny — short-circuit

    const effect = await this.accessPolicy.evaluate(
      params.tenantId,
      params.resource,
      params.action,
      {
        subject: {
          id: params.userId,
          tenantId: params.tenantId,
          principalType: params.principalType ?? 'user',
          groupIds: params.groupIds ?? [],
          ...(params.subject ?? {}),
        },
        resource: params.record ?? { id: params.resourceId },
        env: { now: new Date(), ...(params.env ?? {}) },
      },
    );
    if (effect === 'deny') return false; // ABAC deny-overrides

    // acl is true or null, ABAC is allow or null → access stands.
    return true;
  }
}
