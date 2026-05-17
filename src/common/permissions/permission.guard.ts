import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector, ModuleRef } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { PlatformRoleEnum } from '../../roles/platform-role.enum';
import { UserRepository } from '../../users/infrastructure/persistence/user.repository';
import { GroupRepository } from '../../groups/infrastructure/persistence/document/repositories/group.repository';
import { TenantsRepository } from '../../tenants/infrastructure/persistence/document/repositories/tenant.repository';
import {
  PERMISSION_RULE_METADATA,
  PermissionRuleMetadata,
} from './permission.decorator';
import { getPermissionKey } from './permission.constants';
import { calculateEffectivePermissions, canAccess } from './permission.engine';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly moduleRef: ModuleRef,
    private readonly cls: ClsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<PermissionRuleMetadata>(
      PERMISSION_RULE_METADATA,
      [context.getClass(), context.getHandler()],
    );

    if (!rule) {
      return true;
    }

    const userRepository = this.moduleRef.get(UserRepository, {
      strict: false,
    });
    const tenantsRepository = this.moduleRef.get(TenantsRepository, {
      strict: false,
    });
    const groupRepository = this.moduleRef.get(GroupRepository, {
      strict: false,
    });

    const request = context.switchToHttp().getRequest();
    const payload = request.user;
    const rawUserId =
      this.cls.get<string>('userId') ?? payload?.userId ?? payload?.sub;

    if (!rawUserId) {
      return false;
    }

    const claimPermissions = this.extractEffectivePermissionClaims(payload);
    if (claimPermissions && payload?.tenantId) {
      const allowed =
        this.hasSuperAdminClaim(payload) ||
        this.canAccessClaimPermissions(claimPermissions, rule);
      if (allowed) {
        this.cls.set('userId', String(payload?.userId ?? payload?.sub));
        this.cls.set('email', payload?.email);
        this.cls.set('tenantId', String(payload?.tenantId ?? ''));
        this.cls.set('activeTenantId', String(payload?.tenantId ?? ''));
        this.cls.set('user', payload);
      }
      return allowed;
    }

    const rawUserIdString = String(rawUserId);
    const user = /^[0-9a-fA-F]{24}$/.test(rawUserIdString)
      ? (await userRepository.findByIdsGlobal([rawUserIdString]))[0] || null
      : await userRepository.findByKeycloakIdAndProvider({
          keycloakId: rawUserIdString,
          provider: 'email',
        });

    if (!user) {
      return false;
    }

    const tenantHint =
      this.cls.get<string>('tenantId') ??
      request.tenantAlias ??
      (process.env.NODE_ENV !== 'production'
        ? this.extractHeader(request, 'x-tenant-id')
        : undefined) ??
      payload?.tenantId ??
      user.tenants?.[0]?.tenantId;

    if (!tenantHint) {
      return false;
    }

    const tenantHintString = String(tenantHint);
    const tenant = /^[0-9a-fA-F]{24}$/.test(tenantHintString)
      ? await tenantsRepository.findById(tenantHintString)
      : ((await tenantsRepository.findByAlias(tenantHintString)) ??
        (await tenantsRepository.findByKeycloakOrgId(tenantHintString)));

    if (!tenant) {
      return false;
    }

    this.cls.set('userId', String(user.id));
    this.cls.set('email', user.email ?? payload?.email);
    this.cls.set('tenantId', String(tenant.id));
    this.cls.set('activeTenantId', String(tenant.id));
    this.cls.set('user', payload);
    request.user = {
      ...payload,
      id: String(user.id),
      userId: String(user.id),
    };

    if (user.platformRole?.id === PlatformRoleEnum.SUPER_ADMIN) {
      return true;
    }

    const userGroups = await groupRepository.findGroupsByMember(
      String(tenant.id),
      String(user.id),
    );

    const effectivePermissions = calculateEffectivePermissions(
      tenant,
      user,
      userGroups,
    );

    return canAccess(effectivePermissions, rule.action, rule.resource);
  }

  private extractHeader(request: any, name: string): string | undefined {
    const value = request.headers?.[name];
    if (Array.isArray(value)) return value[0];
    return value;
  }

  private extractEffectivePermissionClaims(payload: any): Set<string> | null {
    const direct =
      payload?.effectivePermissions ??
      payload?.permissions ??
      payload?.authorization?.permissions;

    if (!Array.isArray(direct) || direct.length === 0) {
      return null;
    }

    const permissions = direct
      .map((permission) => {
        if (typeof permission === 'string') return permission;
        if (typeof permission?.rsname === 'string' && permission?.scopes) {
          return permission.scopes.map(
            (scope: string) => `${permission.rsname}:${scope}`,
          );
        }
        return null;
      })
      .flat()
      .filter((permission): permission is string => !!permission);

    return permissions.length > 0 ? new Set(permissions) : null;
  }

  private canAccessClaimPermissions(
    effectivePermissions: Set<string>,
    rule: PermissionRuleMetadata,
  ): boolean {
    const permissionKey = getPermissionKey(rule.action, rule.resource);
    return permissionKey ? effectivePermissions.has(permissionKey) : false;
  }

  private hasSuperAdminClaim(payload: any): boolean {
    const roles = [
      ...(payload?.realm_access?.roles ?? []),
      ...Object.values(payload?.resource_access ?? {}).flatMap(
        (resource: any) => resource?.roles ?? [],
      ),
      ...(payload?.roles ?? []),
    ].map(String);

    return roles.includes(PlatformRoleEnum.SUPER_ADMIN);
  }
}
