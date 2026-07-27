import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsMongoId,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  ASSIGNMENT_OBJECT_TYPES,
  ASSIGNMENT_OUTCOMES,
  ASSIGNMENT_SOURCES,
  ASSIGNMENT_STRATEGIES,
  CONDITION_OPERATORS,
  MATCH_TYPES,
} from '../../domain/assignment.types';

// ── Conditions ─────────────────────────────────────────────────────────────

export class AssignmentConditionDto {
  @ApiProperty({ example: 'priority' })
  @IsString()
  @MaxLength(120)
  field: string;

  @ApiProperty({ enum: CONDITION_OPERATORS })
  @IsEnum(CONDITION_OPERATORS)
  operator: string;

  /**
   * Optional so `is_empty` / `is_not_empty` need not carry a meaningless value.
   * Every other operator requires it, enforced in the service where the
   * operator is known.
   */
  @ApiPropertyOptional({ example: 'urgent' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  value?: string;
}

// ── Actions ────────────────────────────────────────────────────────────────

export class AssignmentActionsDto {
  @ApiPropertyOptional({ description: 'Pin to one user; skips strategy' })
  @IsOptional()
  @IsMongoId()
  userId?: string | null;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Ordered escalation chain; the first team with someone free wins',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsMongoId({ each: true })
  groupIds?: string[];

  @ApiPropertyOptional({
    enum: ASSIGNMENT_STRATEGIES,
    description: 'Omit to inherit the objectType default',
  })
  @IsOptional()
  @IsEnum(ASSIGNMENT_STRATEGIES)
  strategy?: string | null;

  @ApiPropertyOptional({ type: [String], description: 'Skill apiNames' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  requiredSkills?: string[];
}

// ── Rules ──────────────────────────────────────────────────────────────────

export class CreateAssignmentRuleDto {
  @ApiProperty({ enum: ASSIGNMENT_OBJECT_TYPES })
  @IsEnum(ASSIGNMENT_OBJECT_TYPES)
  objectType: string;

  @ApiProperty({ example: 'VIP tickets → senior team' })
  @IsString()
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @ApiPropertyOptional({ enum: MATCH_TYPES })
  @IsOptional()
  @IsEnum(MATCH_TYPES)
  matchType?: string;

  @ApiPropertyOptional({ type: [AssignmentConditionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AssignmentConditionDto)
  conditions?: AssignmentConditionDto[];

  @ApiProperty({ type: AssignmentActionsDto })
  @ValidateNested()
  @Type(() => AssignmentActionsDto)
  actions: AssignmentActionsDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateAssignmentRuleDto extends PartialType(
  CreateAssignmentRuleDto,
) {}

export class ReorderRulesDto {
  @ApiProperty({ enum: ASSIGNMENT_OBJECT_TYPES })
  @IsEnum(ASSIGNMENT_OBJECT_TYPES)
  objectType: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(500)
  @IsMongoId({ each: true })
  orderedIds: string[];
}

// ── Settings ───────────────────────────────────────────────────────────────

export class UpdateAssignmentSettingDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoAssignEnabled?: boolean;

  @ApiPropertyOptional({ enum: ASSIGNMENT_STRATEGIES })
  @IsOptional()
  @IsEnum(ASSIGNMENT_STRATEGIES)
  defaultStrategy?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsMongoId()
  defaultGroupId?: string | null;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  defaultMaxCapacity?: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsMongoId()
  fallbackOwnerId?: string | null;

  @ApiPropertyOptional({ enum: ASSIGNMENT_STRATEGIES })
  @IsOptional()
  @IsEnum(ASSIGNMENT_STRATEGIES)
  fallbackStrategy?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  skillBasedRoutingEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requireOnline?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  preferPreviousAssignee?: boolean;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  previousAssigneeTimeoutHours?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  previousAssigneeWaitMinutes?: number;
}

// ── Skills ─────────────────────────────────────────────────────────────────

export class CreateAssignmentSkillDto {
  @ApiProperty({ example: 'English' })
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ example: 'Language' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class UpdateAssignmentSkillDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

// ── Dry run ────────────────────────────────────────────────────────────────

export class DryRunDto {
  @ApiProperty({ enum: ASSIGNMENT_OBJECT_TYPES })
  @IsEnum(ASSIGNMENT_OBJECT_TYPES)
  objectType: string;

  @ApiProperty({
    description: 'Attribute bag the rule conditions are matched against',
    example: { priority: 'high', tag: ['VIP'] },
  })
  @IsObject()
  attributes: Record<string, any>;

  @ApiPropertyOptional({ description: 'Narrower scope — omni channel id' })
  @IsOptional()
  @IsMongoId()
  scopeId?: string;
}

// ── Audit query ────────────────────────────────────────────────────────────

export class AuditQueryDto {
  @ApiPropertyOptional({ enum: ASSIGNMENT_OBJECT_TYPES })
  @IsOptional()
  @IsEnum(ASSIGNMENT_OBJECT_TYPES)
  objectType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  entityId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  assigneeId?: string;

  @ApiPropertyOptional({ enum: ASSIGNMENT_OUTCOMES })
  @IsOptional()
  @IsEnum(ASSIGNMENT_OUTCOMES)
  outcome?: string;

  @ApiPropertyOptional({ enum: ASSIGNMENT_SOURCES })
  @IsOptional()
  @IsEnum(ASSIGNMENT_SOURCES)
  source?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ruleId?: string;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
