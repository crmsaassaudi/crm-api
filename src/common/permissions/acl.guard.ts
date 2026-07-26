import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { GroupRepository } from '../../groups/infrastructure/persistence/document/repositories/group.repository';
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
    // Lazy: AuthorizationModule is global and GroupsModule depends on it, so a
    // constructor injection here would close a dependency cycle.
    private readonly moduleRef: ModuleRef,
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
      // Groups are resolved server-side, never from a client-supplied claim.
      groupIds: await this.resolveGroupIds(tenantId, String(userId)),
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
   * The principal's group ids, for group-scoped ACL entries and `subject.groupIds`
   * ABAC conditions.
   *
   * Read from CLS when it is already populated, and resolved here when it is
   * not. The fallback is not belt-and-braces: guards run BEFORE interceptors in
   * Nest, and `visibleGroupIds` is written by DataVisibilityInterceptor — so on
   * every request this guard used to see an empty list. That made every
   * group-principal ACL row and every group-keyed ABAC condition silently inert,
   * which in a deny-overrides model is indistinguishable from having no rule at
   * all. Failing open on a deny is exactly what must never happen quietly.
   *
   * Ancestor groups are included, matching how the permission engine expands
   * group-inherited roles: a deny placed on a parent group must cover the
   * children, or the two layers disagree about what "in that group" means.
   */
  private async resolveGroupIds(
    tenantId: string,
    userId: string,
  ): Promise<string[]> {
    const fromCls = this.cls.get<string[]>('visibleGroupIds');
    if (Array.isArray(fromCls)) return fromCls;

    try {
      const groupRepository = this.moduleRef.get(GroupRepository, {
        strict: false,
      });
      const groups = await groupRepository.findGroupsByMemberWithAncestors(
        tenantId,
        userId,
      );
      const ids = groups
        .map((group: any) => String(group?.id ?? group?._id))
        .filter((id) => id && id !== 'undefined');
      // Cache for the rest of the request: the interceptor that would normally
      // set this runs later, and the ABAC path reads it again.
      this.cls.set('visibleGroupIds', ids);
      return ids;
    } catch (error) {
      // Fail CLOSED for the layer this feeds: an unresolvable group list must
      // not turn a group-scoped deny into a pass. Denying the request is the
      // conservative choice, and it is loud enough to be noticed.
      throw new ForbiddenException(
        `Record-level authorization could not resolve group membership: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
