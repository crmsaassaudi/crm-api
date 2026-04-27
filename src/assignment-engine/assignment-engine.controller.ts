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
import { ApiTags, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { AssignmentEngineService } from './assignment-engine.service';
import {
  CreateAssignmentRuleDto,
  UpdateAssignmentRuleDto,
  UpdateAssignmentSettingDto,
  CreateAssignmentSkillDto,
  DryRunDto,
  ReorderRulesDto,
} from './dto/assignment-engine.dto';

@ApiTags('Assignment Engine')
@Controller('assignment-engine')
export class AssignmentEngineController {
  constructor(private readonly service: AssignmentEngineService) {}

  // ── Settings ─────────────────────────────────────────────────────────────

  @Get('settings/:module')
  @ApiOperation({ summary: 'Get assignment settings for a module' })
  @ApiParam({
    name: 'module',
    enum: ['Contact', 'Ticket', 'Task', 'Deal'],
  })
  getSettings(@Param('module') module: string) {
    return this.service.getSettings(module);
  }

  @Put('settings/:module')
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
  @ApiOperation({ summary: 'List assignment rules (optional module filter)' })
  @ApiQuery({ name: 'module', required: false })
  findAllRules(@Query('module') module?: string) {
    return this.service.findAllRules(module);
  }

  @Post('rules')
  @ApiOperation({ summary: 'Create an assignment rule' })
  createRule(@Body() dto: CreateAssignmentRuleDto) {
    return this.service.createRule(dto);
  }

  @Patch('rules/:id')
  @ApiOperation({ summary: 'Update an assignment rule' })
  updateRule(@Param('id') id: string, @Body() dto: UpdateAssignmentRuleDto) {
    return this.service.updateRule(id, dto);
  }

  @Delete('rules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an assignment rule' })
  deleteRule(@Param('id') id: string) {
    return this.service.deleteRule(id);
  }

  @Post('rules/reorder')
  @ApiOperation({ summary: 'Reorder assignment rules by priority' })
  reorderRules(@Body() dto: ReorderRulesDto) {
    return this.service.reorderRules(dto.orderedIds);
  }

  // ── Dry Run ──────────────────────────────────────────────────────────────

  @Post('dry-run')
  @ApiOperation({ summary: 'Simulate assignment without side effects' })
  dryRun(@Body() dto: DryRunDto) {
    return this.service.dryRun(dto);
  }

  // ── Audit Log ────────────────────────────────────────────────────────────

  @Get('audit-log')
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
  @ApiOperation({ summary: 'List managed assignment skills' })
  findAllSkills() {
    return this.service.findAllSkills();
  }

  @Post('skills')
  @ApiOperation({ summary: 'Create a managed skill tag' })
  createSkill(@Body() dto: CreateAssignmentSkillDto) {
    return this.service.createSkill(dto);
  }

  @Delete('skills/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a managed skill tag' })
  deleteSkill(@Param('id') id: string) {
    return this.service.deleteSkill(id);
  }
}
