import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../../common/permissions/permission.decorator';
import { AssignmentAdminService } from './assignment-admin.service';
import {
  ASSIGNMENT_OBJECT_TYPES,
  ASSIGNMENT_STRATEGIES,
  CONDITION_OPERATORS,
} from '../domain/assignment.types';
import {
  AuditQueryDto,
  CreateAssignmentRuleDto,
  CreateAssignmentSkillDto,
  DryRunDto,
  ReorderRulesDto,
  UpdateAssignmentRuleDto,
  UpdateAssignmentSettingDto,
  UpdateAssignmentSkillDto,
} from './dto/assignment.dto';

/**
 * The one assignment API, for every objectType.
 *
 * Replaces `/assignment-engine/*` (records) and `/routing-rules/*`
 * (conversations), which exposed the same six concepts under two shapes.
 *
 * Reads sit behind `settings:view` and writes behind `settings:manage_system`,
 * matching how the two predecessors were guarded — routing rules were the looser
 * of the pair and are tightened here.
 */
@ApiTags('Assignment')
@ApiBearerAuth()
@Controller('assignment')
export class AssignmentController {
  constructor(private readonly service: AssignmentAdminService) {}

  // ── Vocabulary (UI metadata) ───────────────────────────────────────────

  @Get('meta')
  @RequirePermission('view', 'settings')
  @ApiOperation({
    summary: 'Enumerations the UI needs: objectTypes, strategies, operators',
  })
  meta() {
    return {
      objectTypes: ASSIGNMENT_OBJECT_TYPES,
      strategies: ASSIGNMENT_STRATEGIES,
      operators: CONDITION_OPERATORS,
    };
  }

  @Get('fields/:objectType')
  @RequirePermission('view', 'settings')
  @ApiParam({ name: 'objectType', enum: ASSIGNMENT_OBJECT_TYPES })
  @ApiOperation({ summary: 'Conditionable fields and their valid operators' })
  fields(@Param('objectType') objectType: string) {
    return this.service.fieldsFor(objectType);
  }

  // ── Settings ───────────────────────────────────────────────────────────

  @Get('settings')
  @RequirePermission('view', 'settings')
  @ApiOperation({ summary: 'Resolved settings for every objectType' })
  getAllSettings() {
    return this.service.getAllSettings();
  }

  @Get('settings/:objectType')
  @RequirePermission('view', 'settings')
  @ApiParam({ name: 'objectType', enum: ASSIGNMENT_OBJECT_TYPES })
  getSettings(@Param('objectType') objectType: string) {
    return this.service.getSettings(objectType);
  }

  @Put('settings/:objectType')
  @RequirePermission('manage_system', 'settings')
  @ApiParam({ name: 'objectType', enum: ASSIGNMENT_OBJECT_TYPES })
  updateSettings(
    @Param('objectType') objectType: string,
    @Body() dto: UpdateAssignmentSettingDto,
  ) {
    return this.service.updateSettings(objectType, dto);
  }

  // ── Rules ──────────────────────────────────────────────────────────────

  @Get('rules')
  @RequirePermission('view', 'settings')
  @ApiOperation({ summary: 'List rules, optionally filtered by objectType' })
  listRules(@Query('objectType') objectType?: string) {
    return this.service.listRules(objectType);
  }

  @Post('rules')
  @RequirePermission('manage_system', 'settings')
  createRule(@Body() dto: CreateAssignmentRuleDto) {
    return this.service.createRule(dto);
  }

  @Patch('rules/:id')
  @RequirePermission('manage_system', 'settings')
  updateRule(@Param('id') id: string, @Body() dto: UpdateAssignmentRuleDto) {
    return this.service.updateRule(id, dto);
  }

  @Delete('rules/:id')
  @RequirePermission('manage_system', 'settings')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteRule(@Param('id') id: string) {
    return this.service.deleteRule(id);
  }

  @Post('rules/reorder')
  @RequirePermission('manage_system', 'settings')
  @ApiOperation({ summary: 'Reorder rules within one objectType' })
  reorderRules(@Body() dto: ReorderRulesDto) {
    return this.service.reorderRules(dto.objectType, dto.orderedIds);
  }

  // ── Skills ─────────────────────────────────────────────────────────────

  @Get('skills')
  @RequirePermission('view', 'settings')
  listSkills() {
    return this.service.listSkills();
  }

  @Post('skills')
  @RequirePermission('manage_system', 'settings')
  createSkill(@Body() dto: CreateAssignmentSkillDto) {
    return this.service.createSkill(dto);
  }

  @Patch('skills/:id')
  @RequirePermission('manage_system', 'settings')
  updateSkill(@Param('id') id: string, @Body() dto: UpdateAssignmentSkillDto) {
    return this.service.updateSkill(id, dto);
  }

  @Delete('skills/:id')
  @RequirePermission('manage_system', 'settings')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteSkill(@Param('id') id: string) {
    return this.service.deleteSkill(id);
  }

  // ── Dry run ────────────────────────────────────────────────────────────

  @Post('dry-run')
  @RequirePermission('view', 'settings')
  @ApiOperation({
    summary: 'Simulate a decision — no reservation, no write, no audit row',
  })
  dryRun(@Body() dto: DryRunDto) {
    return this.service.dryRun(dto);
  }

  // ── Audit ──────────────────────────────────────────────────────────────

  @Get('audit')
  @RequirePermission('view', 'settings')
  @ApiOperation({ summary: 'Assignment decision history across objectTypes' })
  searchAudit(@Query() query: AuditQueryDto) {
    return this.service.searchAudit(query);
  }

  @Get('audit/:objectType/:entityId')
  @RequirePermission('view', 'settings')
  @ApiParam({ name: 'objectType', enum: ASSIGNMENT_OBJECT_TYPES })
  @ApiOperation({ summary: 'Decision chain for one record, oldest first' })
  auditForEntity(
    @Param('objectType') objectType: string,
    @Param('entityId') entityId: string,
  ) {
    return this.service.auditForEntity(objectType, entityId);
  }
}
