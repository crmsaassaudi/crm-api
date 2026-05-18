import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { PlatformRoleEnum } from '../../roles/platform-role.enum';
import {
  PERMISSION_RULE_METADATA,
  PermissionRuleMetadata,
} from './permission.decorator';
import { AuthzPermissionCacheService } from './authz-permission-cache.service';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authzCache: AuthzPermissionCacheService,
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

    const request = context.switchToHttp().getRequest();
    const payload = request.user;
    const rawUserId =
      this.cls.get<string>('userId') ?? payload?.userId ?? payload?.sub;

    if (!rawUserId) {
      return false;
    }

    const tenantHint =
      this.cls.get<string>('tenantId') ??
      request.tenantAlias ??
      (process.env.NODE_ENV !== 'production'
        ? this.extractHeader(request, 'x-tenant-id')
        : undefined) ??
      payload?.tenantId;

    if (this.hasSuperAdminClaim(payload)) {
      this.setRequestContext(request, payload, {
        userId: String(payload?.userId ?? payload?.id ?? payload?.sub),
        tenantId: tenantHint ? String(tenantHint) : '',
        email: payload?.email,
      });
      return true;
    }

    const result = await this.authzCache.canAccess({
      rawUserId: String(rawUserId),
      tenantHint: tenantHint ? String(tenantHint) : undefined,
      rule,
    });

    if (result.allowed) {
      this.setRequestContext(request, payload, {
        userId: result.userId ?? String(rawUserId),
        tenantId: result.tenantId ?? (tenantHint ? String(tenantHint) : ''),
        email: result.email ?? payload?.email,
      });
    }

    return result.allowed;
  }

  private extractHeader(request: any, name: string): string | undefined {
    const value = request.headers?.[name];
    if (Array.isArray(value)) return value[0];
    return value;
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

  private setRequestContext(
    request: any,
    payload: any,
    context: { userId: string; tenantId: string; email?: string | null },
  ): void {
    this.cls.set('userId', context.userId);
    this.cls.set('email', context.email);
    this.cls.set('tenantId', context.tenantId);
    this.cls.set('activeTenantId', context.tenantId);
    this.cls.set('user', payload);
    request.user = {
      ...payload,
      id: context.userId,
      userId: context.userId,
    };
  }
}
