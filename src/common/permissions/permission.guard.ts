import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import {
  PERMISSION_RULE_METADATA,
  PermissionRuleMetadata,
} from './permission.decorator';
import { AuthorizationService } from './authorization.service';
import { resolvePrincipalType } from './principal';

/**
 * Thin adapter over {@link AuthorizationService} (the single PDP). It resolves
 * request context (userId / tenant hint), delegates the RBAC + platform
 * super-admin decision, then writes CLS context and logs denials.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly authz: AuthorizationService,
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

    const tenantHint = this.resolveTenantHint(request, payload);

    const decision = await this.authz.canPerformAction({
      rule,
      rawUserId: String(rawUserId),
      tenantHint: tenantHint ? String(tenantHint) : undefined,
      claims: payload,
    });

    if (decision.allowed) {
      const resolvedUserId = decision.superAdmin
        ? String(payload?.userId ?? payload?.id ?? payload?.sub)
        : (decision.userId ?? String(rawUserId));
      this.setRequestContext(request, payload, {
        userId: resolvedUserId,
        tenantId: decision.superAdmin
          ? tenantHint
            ? String(tenantHint)
            : ''
          : (decision.tenantId ?? (tenantHint ? String(tenantHint) : '')),
        email: decision.email ?? payload?.email,
        principalType: resolvePrincipalType(payload),
        principalId: resolvedUserId,
      });
      return true;
    }

    this.logDenied(context, request, {
      reason: decision.denyReason ?? 'permission_denied',
      action: rule.action,
      resource: rule.resource,
      requiredPermission: decision.requiredPermission,
      rawUserId: String(rawUserId),
      userId: decision.userId,
      tenantHint: tenantHint ? String(tenantHint) : undefined,
      tenantId: decision.tenantId,
      cacheHit: decision.cacheHit,
    });
    return false;
  }

  /** Resolve tenant hint from CLS, request, headers, or JWT payload. */
  private resolveTenantHint(request: any, payload: any): string | undefined {
    return (
      this.cls.get<string>('tenantId') ??
      request.tenantAlias ??
      (process.env.NODE_ENV !== 'production'
        ? this.extractHeader(request, 'x-tenant-id')
        : undefined) ??
      payload?.tenantId
    );
  }

  private extractHeader(request: any, name: string): string | undefined {
    const value = request.headers?.[name];
    if (Array.isArray(value)) return value[0];
    return value;
  }

  private setRequestContext(
    request: any,
    payload: any,
    context: {
      userId: string;
      tenantId: string;
      email?: string | null;
      principalType: string;
      principalId: string;
    },
  ): void {
    this.cls.set('userId', context.userId);
    this.cls.set('email', context.email);
    this.cls.set('tenantId', context.tenantId);
    this.cls.set('activeTenantId', context.tenantId);
    this.cls.set('user', payload);
    // Actor identity for audit / ABAC / masking (Phase A: principal model).
    this.cls.set('principalType', context.principalType);
    this.cls.set('principalId', context.principalId);
    request.user = {
      ...payload,
      id: context.userId,
      userId: context.userId,
      principalType: context.principalType,
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
