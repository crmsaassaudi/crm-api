import { SetMetadata } from '@nestjs/common';
import { TenantRoleEnum } from './tenant-role.enum';

export const TenantRoles = (...roles: TenantRoleEnum[]) =>
  SetMetadata('tenantRoles', roles);
