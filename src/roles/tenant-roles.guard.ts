import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { TenantRoleEnum } from './tenant-role.enum';
import { PlatformRoleEnum } from './platform-role.enum';
import { UsersService } from '../users/users.service';
import { AuthProvidersEnum } from '../auth/auth-providers.enum';

/**
 * Guards routes by checking the user's role within the *current tenant*.
 * The current tenant is resolved from the CLS (request-scoped) context.
 *
 * Usage:
 *   @TenantRoles(TenantRoleEnum.ADMIN, TenantRoleEnum.OWNER)
 *   @UseGuards(TenantRolesGuard)
 */
@Injectable()
export class TenantRolesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private usersService: UsersService,
    private cls: ClsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<TenantRoleEnum[]>(
      'tenantRoles',
      [context.getClass(), context.getHandler()],
    );
    if (!requiredRoles || !requiredRoles.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const payload = request.user;

    if (!payload || !payload.sub) {
      return false;
    }

    const user = await this.usersService.findByKeycloakIdAndProvider({
      keycloakId: payload.sub,
      provider: AuthProvidersEnum.email,
    });

    if (!user) {
      return false;
    }

    // SUPER_ADMIN bypasses tenant-level role check
    if (user.platformRole?.id === PlatformRoleEnum.SUPER_ADMIN) {
      return true;
    }

    // Resolve current tenant from CLS context
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) {
      return false;
    }

    // Find user's membership in the current tenant
    const membership = user.tenants?.find((t) => t.tenant === tenantId);
    if (!membership) {
      return false;
    }

    // Check if any of the user's tenant roles match the required roles
    return membership.roles.some((r) =>
      requiredRoles.includes(r as TenantRoleEnum),
    );
  }
}
