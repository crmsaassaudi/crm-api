import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * `path` and `depth` appear on no DTO. They are derived from `parentId` and
 * maintained only by the service — accepting either from a caller would let a
 * request place a unit anywhere in the tree, which is a scope grant, not an
 * edit.
 */
export class CreateOrgUnitDto {
  @ApiProperty({ example: 'Sales — North' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({
    example: 'SALES-NORTH',
    description: 'Stable per-tenant identifier; survives a rename.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(/^[A-Za-z0-9._-]+$/, {
    message: 'code may contain only letters, digits, dot, underscore and dash',
  })
  code?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({
    example: '507f1f77bcf86cd799439011',
    description: 'Parent unit; omit or null to create a root.',
  })
  @IsOptional()
  @IsMongoId()
  parentId?: string | null;

  @ApiPropertyOptional({ example: '507f1f77bcf86cd799439011' })
  @IsOptional()
  @IsMongoId()
  managerId?: string | null;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Co-managers. Each of them sees this unit and everything under it once ' +
      'their role enables the managed-units axis.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsMongoId({ each: true })
  managerIds?: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateOrgUnitDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(/^[A-Za-z0-9._-]+$/, {
    message: 'code may contain only letters, digits, dot, underscore and dash',
  })
  code?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({
    description:
      'Move the unit. Null promotes it to a root. Rejected if it would create a cycle or exceed the depth limit.',
  })
  @IsOptional()
  @IsMongoId()
  parentId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  managerId?: string | null;

  @ApiPropertyOptional({
    type: [String],
    description: 'Replaces the whole set.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsMongoId({ each: true })
  managerIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class QueryOrgUnitsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
