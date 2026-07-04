import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AssignmentEngineService } from './assignment-engine.service';
import {
  CreateAssignmentRuleDto,
  UpdateAssignmentRuleDto,
  UpdateAssignmentSettingDto,
  CreateAssignmentSkillDto,
  DryRunDto,
  ReorderRulesDto,
} from './dto/assignment-engine.dto';
import { RequirePermission } from '../common/permissions/permission.decorator';

@ApiTags('Assignment Engine')
@ApiBearerAuth()
@Controller('assignment-engine')
export class AssignmentEngineController {
  constructor(private readonly service: AssignmentEngineService) {}

  // ── Settings ─────────────────────────────────────────────────────────────

  @Get('settings/:module')
  @RequirePermission('view', 'settings')
  @ApiOperation({ summary: 'Get assignment settings for a module' })
  @ApiParam({
    name: 'module',
    enum: ['Contact', 'Ticket', 'Task', 'Deal'],
  })
  getSettings(@Param('module') module: string) {
    return this.service.getSettings(module);
  }

  @Put('settings/:module')
  @RequirePermission('manage_system', 'settings')
  @ApiOperation({ summary: 'Update assignment settings for a module' })
  @ApiParam({
    name: 'module',
    enum: ['Contact', 'Ticket', 'Task', 'Deal'],
  })
  updateSettings(
    @Param('module') module: string,
    @Body() dto: UpdateAssignmentSettingDto,
  ) {
    return this.service.updateSettings(module, dto);
  }

  // ── Rules ────────────────────────────────────────────────────────────────

  @Get('rules')
  @RequirePermission('view', 'settings')
  @ApiOperation({ summary: 'List assignment rules (optional module filter)' })
  @ApiQuery({ name: 'module', required: false })
  findAllRules(@Query('module') module?: string): Promise<any[]> {
    return this.service.findAllRules(module);
  }

  @Post('rules')
  @RequirePermission('manage_system', 'settings')
  @ApiOperation({ summary: 'Create an assignment rule' })
  createRule(@Body() dto: CreateAssignmentRuleDto) {
    return this.service.createRule(dto);
  }

  @Patch('rules/:id')
  @RequirePermission('manage_system', 'settings')
  @ApiOperation({ summary: 'Update an assignment rule' })
  updateRule(@Param('id') id: string, @Body() dto: UpdateAssignmentRuleDto) {
    return this.service.updateRule(id, dto);
  }

  @Delete('rules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('manage_system', 'settings')
  @ApiOperation({ summary: 'Delete an assignment rule' })
  deleteRule(@Param('id') id: string) {
    return this.service.deleteRule(id);
  }

  @Post('rules/reorder')
  @RequirePermission('manage_system', 'settings')
  @ApiOperation({ summary: 'Reorder assignment rules by priority' })
  reorderRules(@Body() dto: ReorderRulesDto): Promise<any[]> {
    return this.service.reorderRules(dto.orderedIds);
  }

  // ── Dry Run ──────────────────────────────────────────────────────────────

  @Post('dry-run')
  @RequirePermission('manage_system', 'settings')
  @ApiOperation({ summary: 'Simulate assignment without side effects' })
  dryRun(@Body() dto: DryRunDto) {
    return this.service.dryRun(dto);
  }

  // ── Audit Log ────────────────────────────────────────────────────────────

  @Get('audit-log')
  @RequirePermission('view', 'settings')
  @ApiOperation({ summary: 'Query assignment audit log' })
  @ApiQuery({ name: 'module', required: false })
  @ApiQuery({ name: 'entityId', required: false })
  getAuditLog(
    @Query('module') module?: string,
    @Query('entityId') entityId?: string,
  ) {
    return this.service.getAuditLog(module, entityId);
  }

  // ── Skills ───────────────────────────────────────────────────────────────

  @Get('skills')
  @RequirePermission('view', 'settings')
  @ApiOperation({ summary: 'List managed assignment skills' })
  findAllSkills(): Promise<any[]> {
    return this.service.findAllSkills();
  }

  @Post('skills')
  @RequirePermission('manage_system', 'settings')
  @ApiOperation({ summary: 'Create a managed skill tag' })
  createSkill(@Body() dto: CreateAssignmentSkillDto) {
    return this.service.createSkill(dto);
  }

  @Delete('skills/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('manage_system', 'settings')
  @ApiOperation({ summary: 'Delete a managed skill tag' })
  deleteSkill(@Param('id') id: string) {
    return this.service.deleteSkill(id);
  }
}
