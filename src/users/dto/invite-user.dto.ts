import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { RoleDto } from '../../roles/dto/role.dto';
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
    description: 'Role within the tenant (OWNER, ADMIN, MEMBER)',
  })
  @IsOptional()
  @IsString()
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
}
