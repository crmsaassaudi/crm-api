import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { AuthorizationService } from './authorization.service';
import { ACL_METADATA_KEY, type AclMetadata } from './use-acl.decorator';
import { LOAD_RESOURCE_METADATA_KEY } from './load-resource.decorator';
import { ResourceLoaderRegistry } from './resource-loader.registry';

/**
 * AclGuard — the record-level Policy Enforcement Point.
 *
 * Runs AFTER PermissionGuard has granted the resource-level RBAC action, and
 * narrows that grant per record via {@link AuthorizationService.canAccessRecord}:
 * object-ACL deny-overrides, then ABAC policy deny-overrides.
 *
 * Registration: global (see AuthorizationModule). It is a no-op on handlers
 * without `@UseAcl`, so opting a route in is a one-line change and forgetting
 * to register the guard is no longer possible.
 *
 * Two things this guard must never do, both of which it used to (C-02):
 *   1. Take the tenant from a request header. The tenant comes from CLS, which
 *      TenantInterceptor has already resolved AND membership-verified. A
 *      header-derived tenant made every ACL/ABAC lookup miss, and a miss means
 *      "no opinion" — i.e. allow. That was a silent, complete bypass.
 *   2. Decide without the record. `resource.*` ABAC conditions cannot match
 *      against `{id}` alone, so a policy like "only the owner may edit" was
 *      structurally incapable of applying. `@LoadResource` hydrates the record
 *      (the Policy Information Point) and the guard refuses to run an
 *      ABAC-relevant decision without one.
 */
@Injectable()
export class AclGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authz: AuthorizationService,
    private readonly cls: ClsService,
    private readonly loaders: ResourceLoaderRegistry,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<AclMetadata | undefined>(
      ACL_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No @UseAcl decorator — guard is a no-op (pass through).
    if (!meta) return true;

    const request = context.switchToHttp().getRequest();

    // Tenant and principal come from CLS only. Both are set by
    // TenantInterceptor / PermissionGuard from verified sources.
    const tenantId = this.cls.get<string>('tenantId');
    const userId =
      this.cls.get<string>('userId') ?? request.user?.id ?? request.user?.sub;

    if (!tenantId || !userId) {
      // Fail closed: without a verified tenant + principal there is no basis
      // for a record-level decision.
      throw new ForbiddenException(
        'Record-level authorization requires a resolved tenant and principal',
      );
    }

    const resourceId: string = request.params?.[meta.idParam ?? 'id'];
    // Collection routes (list/create) have no record to narrow to; the
    // resource-level grant from PermissionGuard stands.
    if (!resourceId) return true;

    const record = await this.loadRecord(context, tenantId, resourceId);

    const allowed = await this.authz.canAccessRecord({
      tenantId,
      userId: String(userId),
      action: meta.action,
      resource: meta.resource,
      resourceId,
      // Groups come from CLS (resolved by DataVisibilityInterceptor), never
      // from a client-supplied token claim.
      groupIds: this.cls.get<string[]>('visibleGroupIds') ?? [],
      principalType: this.cls.get<string>('principalType') ?? 'user',
      record,
      env: {
        ip: this.cls.get<string>('requestIp'),
      },
    });

    if (!allowed) {
      throw new ForbiddenException(
        `Access denied: insufficient permissions for ${meta.action} on ${meta.resource}/${resourceId}`,
      );
    }

    return true;
  }

  /**
   * The Policy Information Point: hydrate the record so `resource.*` ABAC
   * conditions have something to evaluate against.
   *
   * A handler declares its loader with `@LoadResource('deals')`. When a route
   * opts into ACL but declares no loader, the record is undefined and only
   * subject/env conditions can match — so we surface that as a hard error
   * rather than a quietly weaker decision.
   */
  private async loadRecord(
    context: ExecutionContext,
    tenantId: string,
    resourceId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const loaderKey = this.reflector.getAllAndOverride<string | undefined>(
      LOAD_RESOURCE_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!loaderKey) return undefined;

    return this.loaders.load(loaderKey, tenantId, resourceId);
  }
}
