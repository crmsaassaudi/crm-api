import {
  IsString,
  IsOptional,
  IsEnum,
  IsInt,
  IsArray,
  Matches,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const TAG_SCOPES = [
  'Contact',
  'Account',
  'Deal',
  'Ticket',
  'Conversation',
  'Task',
] as const;

const HEX_COLOR_REGEX = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
const HEX_COLOR_MESSAGE = 'color must be a hex value like #ef4444 or #f00';

export class CreateTagDto {
  @ApiProperty({ example: 'VIP' })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name: string;

  @ApiPropertyOptional({ example: '#ef4444' })
  @IsString()
  @IsOptional()
  @Matches(HEX_COLOR_REGEX, { message: HEX_COLOR_MESSAGE })
  color?: string;

  @ApiProperty({ enum: TAG_SCOPES, example: 'Contact' })
  @IsEnum(TAG_SCOPES)
  scope: string;

  @ApiPropertyOptional({ type: [String], example: [] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  channelIds?: string[];

  @ApiPropertyOptional({ example: 0 })
  @IsInt()
  @IsOptional()
  order?: number;
}

export class UpdateTagDto {
  @ApiPropertyOptional({ example: 'VIP Gold' })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: '#f59e0b' })
  @IsString()
  @IsOptional()
  @Matches(HEX_COLOR_REGEX, { message: HEX_COLOR_MESSAGE })
  color?: string;

  @ApiPropertyOptional({ enum: TAG_SCOPES, example: 'Contact' })
  @IsEnum(TAG_SCOPES)
  @IsOptional()
  scope?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  channelIds?: string[];

  @ApiPropertyOptional({ example: 0 })
  @IsInt()
  @IsOptional()
  order?: number;
}

export class QueryTagDto {
  @ApiPropertyOptional({ enum: TAG_SCOPES })
  @IsEnum(TAG_SCOPES)
  @IsOptional()
  scope?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  search?: string;
}

export class ReorderTagsDto {
  @ApiProperty({ enum: TAG_SCOPES, example: 'Contact' })
  @IsEnum(TAG_SCOPES)
  scope: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  orderedIds: string[];
}

export class MergeTagDto {
  @ApiProperty({ example: '507f1f77bcf86cd799439099' })
  @IsString()
  targetTagId: string;
}
