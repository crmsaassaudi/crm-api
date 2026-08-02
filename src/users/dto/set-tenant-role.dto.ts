import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

/**
 * Promote/demote a member inside the current tenant.
 *
 * Only ADMIN and MEMBER are accepted: OWNER is derived from `tenant.ownerId`,
 * so ownership is transferred rather than assigned here.
 */
export class SetTenantRoleDto {
  @ApiProperty({ enum: ['ADMIN', 'MEMBER'], example: 'ADMIN' })
  @IsIn(['ADMIN', 'MEMBER'])
  tenantRole: 'ADMIN' | 'MEMBER';
}
