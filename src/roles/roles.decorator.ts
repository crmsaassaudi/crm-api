import { SetMetadata } from '@nestjs/common';
import { PlatformRoleEnum } from './platform-role.enum';

export const Roles = (...roles: PlatformRoleEnum[]) => SetMetadata('roles', roles);
