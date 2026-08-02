import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEmail,
  IsIn,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { RoleDto } from '../../roles/dto/role.dto';
import { TenantRoleEnum } from '../../roles/tenant-role.enum';
import { Transform, Type } from 'class-transformer';
import { lowerCaseTransformer } from '../../utils/transformers/lower-case.transformer';

export class InviteUserDto {
  @ApiProperty({ example: 'test1@example.com' })
  @Transform(lowerCaseTransformer)
  @IsNotEmpty()
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ type: RoleDto })
  @IsOptional()
  @Type(() => RoleDto)
  role?: RoleDto | null;

  @ApiPropertyOptional({
    example: 'MEMBER',
    enum: [TenantRoleEnum.ADMIN, TenantRoleEnum.MEMBER],
    description:
      'Membership tier. ADMIN grants the whole tenant ceiling and may only be ' +
      'granted by someone who already holds it. OWNER is not accepted here — ' +
      'ownership is transferred, not invited.',
  })
  @IsOptional()
  @IsIn([TenantRoleEnum.ADMIN, TenantRoleEnum.MEMBER])
  tenantRole?: string;

  @ApiPropertyOptional({
    description:
      'Custom/system role ids granted in this tenant. Omit to fall back to the built-in Read Only baseline — never leave a new member with zero permissions.',
    example: ['665f0c1e2b9a4c0012ab34cd'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roleIds?: string[];

  @ApiPropertyOptional({
    description:
      'Org unit to file the member under. Omit to inherit the inviter’s unit. ' +
      'This is the anchor for every ORG_UNIT scope: a member with no unit ' +
      'resolves that axis to an empty set and sees nothing through it.',
    example: '665f0c1e2b9a4c0012ab34cd',
  })
  @IsOptional()
  @IsMongoId()
  orgUnitId?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Groups to add the member to. Each carries its own grant check.',
  })
  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  groupIds?: string[];

  @ApiPropertyOptional({
    description:
      'Manager, for the SUBORDINATES scope. Omit to inherit the inviter.',
    example: '665f0c1e2b9a4c0012ab34cd',
  })
  @IsOptional()
  @IsMongoId()
  reportsToId?: string;
}
