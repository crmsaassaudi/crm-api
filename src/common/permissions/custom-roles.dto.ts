import {
  IsString,
  IsArray,
  IsOptional,
  IsIn,
  MaxLength,
  MinLength,
  IsInt,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DATA_SCOPE_ORDER, DataScope } from './data-scope.enum';

/**
 * `dataScope` is validated against DATA_SCOPE_ORDER rather than accepted as a
 * free string. An unrecognised value would be ignored by `maxScope()` at
 * evaluation time, so the role would silently grant less than the admin who
 * typed it believes -- a scope the UI displays but the engine never applies.
 * Rejecting it at the write boundary keeps the catalogue honest.
 */
const DATA_SCOPE_DOC = {
  enum: DATA_SCOPE_ORDER,
  nullable: true,
  example: DataScope.ORG_UNIT,
  description:
    'Read breadth inside the tenant. Null = no opinion, tenant default applies. Users with several roles get the widest.',
} as const;

export class CreateCustomRoleDto {
  @ApiProperty({ example: 'Sales Agent' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({
    example: 'Can view and create leads, contacts and deals.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ example: ['contacts:view', 'deals:create'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];

  @ApiPropertyOptional({ example: '#6366f1' })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiPropertyOptional(DATA_SCOPE_DOC)
  @IsOptional()
  @IsIn([...DATA_SCOPE_ORDER, null])
  dataScope?: DataScope | null;
}

export class CloneCustomRoleDto {
  @ApiPropertyOptional({
    example: 'Sales Rep (EMEA)',
    description: 'Defaults to "Copy of <source role>".',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;
}

export class UpdateCustomRoleDto {
  @ApiPropertyOptional({ example: 'Updated Role Name' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    example: ['contacts:view', 'deals:create', 'deals:edit'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  color?: string;

  @ApiPropertyOptional(DATA_SCOPE_DOC)
  @IsOptional()
  @IsIn([...DATA_SCOPE_ORDER, null])
  dataScope?: DataScope | null;
}

export class RollbackCustomRoleDto {
  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  revision: number;
}
