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
import { Transform } from 'class-transformer';
import { lowerCaseTransformer } from '../../utils/transformers/lower-case.transformer';
import { TenantRoleEnum } from '../../roles/tenant-role.enum';

export class CreateUserForTenantDto {
  @ApiProperty({ example: 'test1@example.com' })
  @Transform(lowerCaseTransformer)
  @IsNotEmpty()
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'John' })
  @IsNotEmpty()
  @IsString()
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  @IsNotEmpty()
  @IsString()
  lastName: string;

  @ApiPropertyOptional({
    example: 'MEMBER',
    enum: [TenantRoleEnum.ADMIN, TenantRoleEnum.MEMBER],
    description:
      'Membership tier. ADMIN grants the whole tenant ceiling and may only be ' +
      'granted by someone who already holds it.',
  })
  @IsOptional()
  @IsIn([TenantRoleEnum.ADMIN, TenantRoleEnum.MEMBER])
  tenantRole?: string;

  @ApiPropertyOptional({
    description:
      'Custom/system role ids granted in this tenant. Omit to fall back to the built-in Read Only baseline.',
    example: ['665f0c1e2b9a4c0012ab34cd'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roleIds?: string[];

  @ApiPropertyOptional({
    description:
      'Org unit to file the member under. Omit to inherit the creator’s unit.',
    example: '665f0c1e2b9a4c0012ab34cd',
  })
  @IsOptional()
  @IsMongoId()
  orgUnitId?: string;

  @ApiPropertyOptional({ type: [String], description: 'Groups to join.' })
  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  groupIds?: string[];

  @ApiPropertyOptional({
    description: 'Manager, for the SUBORDINATES scope.',
    example: '665f0c1e2b9a4c0012ab34cd',
  })
  @IsOptional()
  @IsMongoId()
  reportsToId?: string;
}
