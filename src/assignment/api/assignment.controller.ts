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
  CONDITION_OPERATORS,
} from '../domain/assignment.types';
import {
  AuditQueryDto,
  ClaimAssignmentQueueItemDto,
  CreateAssignmentRuleDto,
  CreateAssignmentSkillDto,
  DryRunDto,
  ReorderRulesDto,
  UpdateAssignmentRuleDto,
  UpdateAssignmentSettingDto,
  UpdateAssignmentSkillDto,
} from './dto/assignment.dto';
import { AssignmentQueueCommandService } from '../application/assignment-queue-command.service';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { AssignableTypeRegistry } from '../core/assignable-type.registry';
import { AssignmentStrategyRegistry } from '../core/assignment-strategy.registry';

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
  constructor(
    private readonly service: AssignmentAdminService,
    private readonly queueCommands: AssignmentQueueCommandService,
    private readonly assignableTypes: AssignableTypeRegistry,
    private readonly strategyRegistry: AssignmentStrategyRegistry,
  ) {}

  // ── Vocabulary (UI metadata) ───────────────────────────────────────────

  @Get('meta')
  @RequirePermission('view', 'routing_rules')
  @ApiOperation({
    summary: 'Enumerations the UI needs: objectTypes, strategies, operators',
  })
  meta() {
    return {
      objectTypes: this.assignableTypes.list().map((item) => item.objectType),
      strategies: [
        ...this.strategyRegistry.list().map((plugin) => plugin.name),
        'manual',
      ],
      operators: CONDITION_OPERATORS,
      capabilities: Object.fromEntries(
        this.assignableTypes
          .list()
          .map(({ objectType, ...capabilities }) => [objectType, capabilities]),
      ),
    };
  }

  @Get('fields/:objectType')
  @RequirePermission('view', 'routing_rules')
  @ApiParam({ name: 'objectType', enum: ASSIGNMENT_OBJECT_TYPES })
  @ApiOperation({ summary: 'Conditionable fields and their valid operators' })
  fields(@Param('objectType') objectType: string) {
    return this.service.fieldsFor(objectType);
  }

  // ── Settings ───────────────────────────────────────────────────────────

  @Get('settings')
  @RequirePermission('view', 'routing_rules')
  @ApiOperation({ summary: 'Resolved settings for every objectType' })
  getAllSettings() {
    return this.service.getAllSettings();
  }

  @Get('settings/:objectType')
  @RequirePermission('view', 'routing_rules')
  @ApiParam({ name: 'objectType', enum: ASSIGNMENT_OBJECT_TYPES })
  getSettings(@Param('objectType') objectType: string) {
    return this.service.getSettings(objectType);
  }

  @Put('settings/:objectType')
  @RequirePermission('edit', 'routing_rules')
  @ApiParam({ name: 'objectType', enum: ASSIGNMENT_OBJECT_TYPES })
  updateSettings(
    @Param('objectType') objectType: string,
    @Body() dto: UpdateAssignmentSettingDto,
  ) {
    return this.service.updateSettings(objectType, dto);
  }

  // ── Rules ──────────────────────────────────────────────────────────────

  @Get('rules')
  @RequirePermission('view', 'routing_rules')
  @ApiOperation({ summary: 'List rules, optionally filtered by objectType' })
  listRules(@Query('objectType') objectType?: string) {
    return this.service.listRules(objectType);
  }

  @Post('rules')
  @RequirePermission('create', 'routing_rules')
  createRule(@Body() dto: CreateAssignmentRuleDto) {
    return this.service.createRule(dto);
  }

  @Patch('rules/:id')
  @RequirePermission('edit', 'routing_rules')
  updateRule(@Param('id') id: string, @Body() dto: UpdateAssignmentRuleDto) {
    return this.service.updateRule(id, dto);
  }

  @Delete('rules/:id')
  @RequirePermission('delete', 'routing_rules')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteRule(@Param('id') id: string) {
    return this.service.deleteRule(id);
  }

  @Post('rules/reorder')
  @RequirePermission('edit', 'routing_rules')
  @ApiOperation({ summary: 'Reorder rules within one objectType' })
  reorderRules(@Body() dto: ReorderRulesDto) {
    return this.service.reorderRules(dto.objectType, dto.orderedIds);
  }

  // ── Skills ─────────────────────────────────────────────────────────────

  @Get('skills')
  @RequirePermission('view', 'routing_rules')
  listSkills() {
    return this.service.listSkills();
  }

  @Post('skills')
  @RequirePermission('create', 'routing_rules')
  createSkill(@Body() dto: CreateAssignmentSkillDto) {
    return this.service.createSkill(dto);
  }

  @Patch('skills/:id')
  @RequirePermission('edit', 'routing_rules')
  updateSkill(@Param('id') id: string, @Body() dto: UpdateAssignmentSkillDto) {
    return this.service.updateSkill(id, dto);
  }

  @Delete('skills/:id')
  @RequirePermission('delete', 'routing_rules')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteSkill(@Param('id') id: string) {
    return this.service.deleteSkill(id);
  }

  // ── Dry run ────────────────────────────────────────────────────────────

  @Post('dry-run')
  @RequirePermission('view', 'routing_rules')
  @ApiOperation({
    summary: 'Simulate a decision — no reservation, no write, no audit row',
  })
  dryRun(@Body() dto: DryRunDto) {
    return this.service.dryRun(dto);
  }

  // ── Audit ──────────────────────────────────────────────────────────────

  @Get('queue')
  @RequirePermission('view', 'routing_rules')
  @ApiOperation({ summary: 'Oldest-first durable CRM assignment queue' })
  listQueue(
    @Query('objectType') objectType?: string,
    @Query('groupId') groupId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listQueue({
      objectType,
      groupId,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('queue/:id/claim')
  @RequirePermission('edit', 'routing_rules')
  @Idempotent()
  @ApiOperation({ summary: 'Atomically claim a queued CRM record' })
  claimQueueItem(
    @Param('id') id: string,
    @Body() dto: ClaimAssignmentQueueItemDto,
  ) {
    return this.queueCommands.claim(id, dto.assigneeId);
  }

  @Post('queue/:id/retry')
  @RequirePermission('edit', 'routing_rules')
  @Idempotent()
  @ApiOperation({ summary: 'Retry automatic assignment for a queued record' })
  retryQueueItem(@Param('id') id: string) {
    return this.queueCommands.retry(id);
  }

  @Get('audit')
  @RequirePermission('view', 'audit_logs')
  @ApiOperation({ summary: 'Assignment decision history across objectTypes' })
  searchAudit(@Query() query: AuditQueryDto) {
    return this.service.searchAudit(query);
  }

  @Get('audit/:objectType/:entityId')
  @RequirePermission('view', 'audit_logs')
  @ApiParam({ name: 'objectType', enum: ASSIGNMENT_OBJECT_TYPES })
  @ApiOperation({ summary: 'Decision chain for one record, oldest first' })
  auditForEntity(
    @Param('objectType') objectType: string,
    @Param('entityId') entityId: string,
  ) {
    return this.service.auditForEntity(objectType, entityId);
  }
}
