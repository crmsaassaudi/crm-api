import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
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
  private readonly logger = new Logger(PermissionGuard.name);

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
      this.logDenied(context, request, {
        reason: 'missing_user',
        action: rule.action,
        resource: rule.resource,
        tenantHint: this.cls.get<string>('tenantId') ?? request.tenantAlias,
      });
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
    } else {
      this.logDenied(context, request, {
        reason: result.denyReason ?? 'permission_denied',
        action: rule.action,
        resource: rule.resource,
        requiredPermission: result.requiredPermission,
        rawUserId: String(rawUserId),
        userId: result.userId,
        tenantHint: tenantHint ? String(tenantHint) : undefined,
        tenantId: result.tenantId,
        cacheHit: result.cacheHit,
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

  private logDenied(
    context: ExecutionContext,
    request: any,
    details: Record<string, unknown>,
  ): void {
    const handler = context.getHandler();
    const controller = context.getClass();
    this.logger.warn(
      `Permission denied ${JSON.stringify({
        method: request.method,
        path: request.originalUrl ?? request.url,
        controller: controller?.name,
        handler: handler?.name,
        ...details,
      })}`,
    );
  }
}
