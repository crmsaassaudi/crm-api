import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsMongoId, IsOptional } from 'class-validator';
import { TenantRoleEnum } from '../../roles/tenant-role.enum';

/**
 * The placement an invite is about to create, so the dialog can show what the
 * person will actually see before it happens.
 *
 * Nothing here is persisted, and OWNER is not accepted: ownership is
 * transferred, never granted through an invite, so previewing it would answer
 * a question the form cannot ask.
 */
export class PreviewMembershipAccessDto {
  @ApiProperty({ enum: [TenantRoleEnum.ADMIN, TenantRoleEnum.MEMBER] })
  @IsEnum([TenantRoleEnum.ADMIN, TenantRoleEnum.MEMBER])
  tenantRole: TenantRoleEnum.ADMIN | TenantRoleEnum.MEMBER;

  @ApiPropertyOptional({ type: [String], description: 'Candidate role ids' })
  @IsArray()
  @IsMongoId({ each: true })
  @IsOptional()
  roleIds?: string[];
}
