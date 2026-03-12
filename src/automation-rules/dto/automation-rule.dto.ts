import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsArray,
  ValidateNested,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

const MATCH_TYPES = ['all', 'any'] as const;

class TriggerConditionDto {
  @ApiProperty({ example: 'priority' })
  @IsString()
  field: string;

  @ApiProperty({ example: 'equals' })
  @IsString()
  operator: string;

  @ApiProperty({ example: 'high' })
  @IsString()
  value: string;
}

class TriggerDto {
  @ApiProperty({ example: 'ticket.created' })
  @IsString()
  event: string;

  @ApiProperty({ enum: MATCH_TYPES, example: 'all' })
  @IsEnum(MATCH_TYPES)
  matchType: string;

  @ApiProperty({ type: [TriggerConditionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TriggerConditionDto)
  conditions: TriggerConditionDto[];
}

class AutomationActionDto {
  @ApiProperty({ example: 'assign' })
  @IsString()
  type: string;

  @ApiProperty({ example: 'team-senior' })
  @IsString()
  value: string;
}

export class CreateAutomationRuleDto {
  @ApiProperty({ example: 'Auto-assign new tickets' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiProperty({ type: TriggerDto })
  @ValidateNested()
  @Type(() => TriggerDto)
  trigger: TriggerDto;

  @ApiProperty({ type: [AutomationActionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AutomationActionDto)
  actions: AutomationActionDto[];

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}

export class UpdateAutomationRuleDto {
  @ApiPropertyOptional({ example: 'Updated Rule' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ type: TriggerDto })
  @ValidateNested()
  @Type(() => TriggerDto)
  @IsOptional()
  trigger?: TriggerDto;

  @ApiPropertyOptional({ type: [AutomationActionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AutomationActionDto)
  @IsOptional()
  actions?: AutomationActionDto[];

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}
