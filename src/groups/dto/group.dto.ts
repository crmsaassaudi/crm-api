import {
  IsArray,
  IsBoolean,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class CreateGroupDto {
  @ApiProperty({ example: 'Sales Team' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ example: 'Main sales department' })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    example: '507f1f77bcf86cd799439011',
    nullable: true,
  })
  @IsMongoId()
  @IsOptional()
  parentGroupId?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsMongoId({ each: true })
  @IsOptional()
  memberIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    example: ['leads:view', 'leads:create'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  permissions?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Custom role IDs' })
  @IsArray()
  @IsMongoId({ each: true })
  @IsOptional()
  roleIds?: string[];

  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional({ example: '#3b82f6' })
  @IsString()
  @IsOptional()
  color?: string;
}

export class UpdateGroupDto {
  @ApiPropertyOptional({ example: 'Sales Team Updated' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: 'Updated description' })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsMongoId()
  @IsOptional()
  parentGroupId?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsMongoId({ each: true })
  @IsOptional()
  memberIds?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  permissions?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Custom role IDs' })
  @IsArray()
  @IsMongoId({ each: true })
  @IsOptional()
  roleIds?: string[];

  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional({ example: '#10b981' })
  @IsString()
  @IsOptional()
  color?: string | null;
}

/**
 * Unsaved group form state, for the "what will members inherit" preview.
 * Not keyed on an id: the create dialog has no group yet, and that is precisely
 * the case an admin most needs answered before saving.
 */
export class PreviewGroupAccessDto {
  @ApiPropertyOptional({ type: [String], description: 'Custom role IDs' })
  @IsArray()
  @IsMongoId({ each: true })
  @IsOptional()
  roleIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Legacy direct grants still held by the group',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  permissions?: string[];

  @ApiPropertyOptional({
    nullable: true,
    description: 'Prospective parent — may differ from what is stored',
  })
  @IsMongoId()
  @IsOptional()
  parentGroupId?: string | null;
}

export class QueryGroupDto {
  @ApiPropertyOptional({ description: 'Search by name or description' })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Filter by parent group id. Pass "null" for root groups.',
  })
  @IsOptional()
  parentGroupId?: string;
}
