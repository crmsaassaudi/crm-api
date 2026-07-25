import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { lowerCaseTransformer } from '../../utils/transformers/lower-case.transformer';

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
    description: 'Role within the tenant (OWNER, ADMIN, MEMBER)',
  })
  @IsOptional()
  @IsString()
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
}
