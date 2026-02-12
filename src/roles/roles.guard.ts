import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { UsersService } from '../users/users.service';
import { AuthProvidersEnum } from '../auth/auth-providers.enum';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private usersService: UsersService,
  ) { }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<(number | string)[]>(
      'roles',
      [context.getClass(), context.getHandler()],
    );
    if (!roles.length) {
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

    return roles.map(String).includes(String(user.role?.id));
  }
}
