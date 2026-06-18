import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsObject,
  Min,
  Max,
  MinLength,
} from 'class-validator';
import { LeadScoringService } from './lead-scoring.service';
import { ClsService } from 'nestjs-cls';
import { RequirePermission } from '../common/permissions/permission.decorator';
import { SCORING_OPERATORS, SCORABLE_FIELDS } from './lead-scoring-rule.schema';

// ── DTOs ─────────────────────────────────────────────────────────────────────

class ScoringConditionDto {
  @ApiProperty({ example: 'emails' })
  @IsString()
  field: string;

  @ApiProperty({ enum: SCORING_OPERATORS })
  @IsEnum(SCORING_OPERATORS)
  operator: string;

  @ApiPropertyOptional({ example: 'newsletter' })
  @IsOptional()
  value?: string | number | boolean;

  @ApiPropertyOptional({ example: 'industry' })
  @IsString()
  @IsOptional()
  customFieldKey?: string;
}

class CreateLeadScoringRuleDto {
  @ApiProperty({ example: 'Has email address' })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    example: 10,
    description: 'Positive = add points, negative = deduct',
  })
  @IsNumber()
  @Min(-1000)
  @Max(1000)
  points: number;

  @ApiProperty({ type: ScoringConditionDto })
  @IsObject()
  condition: ScoringConditionDto;

  @ApiPropertyOptional({
    enum: ['on_create', 'on_update', 'on_activity', 'always'],
  })
  @IsEnum(['on_create', 'on_update', 'on_activity', 'always'])
  @IsOptional()
  trigger?: string;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  sortOrder?: number;
}

class UpdateLeadScoringRuleDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  points?: number;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  condition?: ScoringConditionDto;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  sortOrder?: number;
}

// ── Controller ────────────────────────────────────────────────────────────────

@ApiTags('Lead Scoring')
@ApiBearerAuth()
@Controller({ path: 'lead-scoring', version: '1' })
export class LeadScoringController {
  constructor(
    private readonly service: LeadScoringService,
    private readonly cls: ClsService,
  ) {}

  @Get('rules')
  @RequirePermission('view', 'contacts')
  @ApiOperation({ summary: 'List all lead scoring rules for the tenant' })
  async listRules() {
    const tenantId = this.cls.get('tenantId');
    return this.service.listRules(tenantId);
  }

  @Post('rules')
  @RequirePermission('edit', 'contacts')
  @ApiOperation({ summary: 'Create a lead scoring rule' })
  async createRule(@Body() dto: CreateLeadScoringRuleDto) {
    const tenantId = this.cls.get('tenantId');
    return this.service.createRule(tenantId, dto as any);
  }

  @Patch('rules/:id')
  @RequirePermission('edit', 'contacts')
  @ApiOperation({ summary: 'Update a lead scoring rule' })
  async updateRule(
    @Param('id') id: string,
    @Body() dto: UpdateLeadScoringRuleDto,
  ) {
    const tenantId = this.cls.get('tenantId');
    return this.service.updateRule(tenantId, id, dto as any);
  }

  @Delete('rules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('edit', 'contacts')
  @ApiOperation({ summary: 'Delete a lead scoring rule' })
  async deleteRule(@Param('id') id: string) {
    const tenantId = this.cls.get('tenantId');
    await this.service.deleteRule(tenantId, id);
  }

  @Post('rules/:id/toggle')
  @RequirePermission('edit', 'contacts')
  @ApiOperation({ summary: 'Enable/disable a rule' })
  async toggleRule(
    @Param('id') id: string,
    @Body() body: { isActive: boolean },
  ) {
    const tenantId = this.cls.get('tenantId');
    return this.service.toggleRule(tenantId, id, body.isActive);
  }

  @Post('rescore')
  @RequirePermission('edit', 'contacts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger bulk re-score for all contacts in tenant' })
  async bulkRescore() {
    const tenantId = this.cls.get('tenantId');
    const result = await this.service.bulkRescoreForTenant(tenantId);
    return { message: 'Bulk re-score complete', ...result };
  }

  @Get('meta/fields')
  @RequirePermission('view', 'contacts')
  @ApiOperation({ summary: 'List scorable field paths' })
  getFields() {
    return { fields: SCORABLE_FIELDS, operators: SCORING_OPERATORS };
  }
}
