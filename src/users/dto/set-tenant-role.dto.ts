import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

/**
 * Promote/demote a member inside the current tenant.
 *
 * Only ADMIN and MEMBER are accepted: OWNER is derived from `tenant.ownerId`
 * (transfer ownership instead), and VIEWER/GUEST carry no meaning in
 * permission.engine.ts — they would resolve to zero permissions, which is what
 * MEMBER already does.
 */
export class SetTenantRoleDto {
  @ApiProperty({ enum: ['ADMIN', 'MEMBER'], example: 'ADMIN' })
  @IsIn(['ADMIN', 'MEMBER'])
  tenantRole: 'ADMIN' | 'MEMBER';
}
