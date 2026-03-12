import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsNumber,
  IsArray,
  ValidateNested,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

const MATCH_TYPES = ['all', 'any'] as const;
const STRATEGIES = ['round_robin', 'least_busy', 'manual'] as const;

class RoutingConditionDto {
  @ApiProperty({ example: 'channel' })
  @IsString()
  field: string;

  @ApiProperty({ example: 'equals' })
  @IsString()
  operator: string;

  @ApiProperty({ example: 'email' })
  @IsString()
  value: string;
}

class RoutingActionsDto {
  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  @IsString()
  teamId: string;

  @ApiProperty({ enum: STRATEGIES, example: 'round_robin' })
  @IsEnum(STRATEGIES)
  strategy: string;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  sticky: boolean;
}

export class CreateRoutingRuleDto {
  @ApiProperty({ example: 'Route VIP to Senior Team' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ example: 0 })
  @IsNumber()
  @IsOptional()
  priority?: number;

  @ApiProperty({ enum: MATCH_TYPES, example: 'all' })
  @IsEnum(MATCH_TYPES)
  matchType: string;

  @ApiProperty({ type: [RoutingConditionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoutingConditionDto)
  conditions: RoutingConditionDto[];

  @ApiProperty({ type: RoutingActionsDto })
  @ValidateNested()
  @Type(() => RoutingActionsDto)
  actions: RoutingActionsDto;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}

export class UpdateRoutingRuleDto {
  @ApiPropertyOptional({ example: 'Updated Rule' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ enum: MATCH_TYPES })
  @IsEnum(MATCH_TYPES)
  @IsOptional()
  matchType?: string;

  @ApiPropertyOptional({ type: [RoutingConditionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoutingConditionDto)
  @IsOptional()
  conditions?: RoutingConditionDto[];

  @ApiPropertyOptional({ type: RoutingActionsDto })
  @ValidateNested()
  @Type(() => RoutingActionsDto)
  @IsOptional()
  actions?: RoutingActionsDto;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}

export class ReorderRoutingRulesDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  orderedIds: string[];
}
