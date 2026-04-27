import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsArray,
  IsBoolean,
  IsNumber,
  ValidateNested,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

// ── Condition DTO ──────────────────────────────────────────────────────────
class ConditionDto {
  @ApiProperty({ example: 'priority' })
  @IsString()
  field: string;

  @ApiProperty({ enum: ['eq', 'neq', 'contains', 'in', 'gt', 'lt', 'between'] })
  @IsEnum(['eq', 'neq', 'contains', 'in', 'gt', 'lt', 'between'])
  operator: string;

  @ApiProperty({ example: 'urgent' })
  @IsString()
  value: string;
}

// ── Actions DTO ────────────────────────────────────────────────────────────
class ActionsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assignToUserId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assignToTeamId?: string;

  @ApiProperty({ enum: ['round-robin', 'least-busy', 'manual'] })
  @IsEnum(['round-robin', 'least-busy', 'manual'])
  strategy: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  requiredSkills?: string[];
}

// ── Create Rule DTO ────────────────────────────────────────────────────────
export class CreateAssignmentRuleDto {
  @ApiProperty({ enum: ['Contact', 'Ticket', 'Task', 'Deal'] })
  @IsEnum(['Contact', 'Ticket', 'Task', 'Deal'])
  module: string;

  @ApiProperty({ example: 'Urgent Tickets → Senior Team' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  priority?: number;

  @ApiPropertyOptional({ enum: ['all', 'any'] })
  @IsOptional()
  @IsEnum(['all', 'any'])
  matchType?: string;

  @ApiPropertyOptional({ type: [ConditionDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConditionDto)
  conditions?: ConditionDto[];

  @ApiProperty({ type: ActionsDto })
  @ValidateNested()
  @Type(() => ActionsDto)
  actions: ActionsDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateAssignmentRuleDto extends PartialType(
  CreateAssignmentRuleDto,
) {}

// ── Settings DTO ───────────────────────────────────────────────────────────
export class UpdateAssignmentSettingDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoAssignEnabled?: boolean;

  @ApiPropertyOptional({ enum: ['round-robin', 'least-busy', 'manual'] })
  @IsOptional()
  @IsEnum(['round-robin', 'least-busy', 'manual'])
  defaultStrategy?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultTeamId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1)
  defaultMaxCapacity?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  prioritizeCurrentOwner?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  triggerFields?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  fallbackOwnerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  respectWorkingHours?: boolean;
}

// ── Skill DTO ──────────────────────────────────────────────────────────────
export class CreateAssignmentSkillDto {
  @ApiProperty({ example: 'English' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: 'Language' })
  @IsOptional()
  @IsString()
  category?: string;
}

// ── Dry Run DTO ────────────────────────────────────────────────────────────
export class DryRunDto {
  @ApiProperty({ enum: ['Contact', 'Ticket', 'Task', 'Deal'] })
  @IsEnum(['Contact', 'Ticket', 'Task', 'Deal'])
  module: string;

  @ApiProperty({ description: 'Entity attributes for rule matching' })
  attributes: Record<string, any>;
}

// ── Reorder DTO ────────────────────────────────────────────────────────────
export class ReorderRulesDto {
  @ApiProperty({ description: 'Ordered array of rule IDs' })
  @IsArray()
  @IsString({ each: true })
  orderedIds: string[];
}
