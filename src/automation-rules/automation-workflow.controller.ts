import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AutomationWorkflowService } from './automation-workflow.service';
import { WorkflowDryRunService } from './engine/workflow-dry-run.service';
import {
  CreateWorkflowDto,
  DryRunWorkflowDto,
  UpdateWorkflowDto,
  UpdateWorkflowStatusDto,
} from './dto/workflow.dto';
import { RequirePermission } from '../common/permissions/permission.decorator';
import {
  AUTOMATION_ACTION_TYPES,
  AutomationActionType,
} from './queue/automation-queue.constants';
import {
  AUTOMATION_TRIGGER_EVENTS,
  AUTOMATION_TRIGGER_OBJECTS,
} from './domain/trigger-catalog';

/** Actions that cannot run against an omni trigger. Mirrors the save-time check. */
const CRM_ONLY_ACTIONS: AutomationActionType[] = [
  'update_field',
  'add_tag',
  'remove_tag',
  'add_note',
];

/** Actions that must name a tenant channel config. */
const CONFIG_REQUIRED_ACTIONS: AutomationActionType[] = [
  'send_email',
  'send_sms',
];

@ApiTags('Automation Workflows')
@ApiBearerAuth()
@Controller({ path: 'automation-workflows', version: '1' })
export class AutomationWorkflowController {
  constructor(
    private readonly service: AutomationWorkflowService,
    private readonly dryRun: WorkflowDryRunService,
  ) {}

  /**
   * What the engine can actually do.
   *
   * The builder used to hard-code its own lists of trigger events and action
   * types. They drifted: the toolbox offered two send actions the API rejected at
   * save time, and the trigger panel offered seven event types the DTO refused —
   * including one whose help text asserted an hourly scan that had been disabled.
   * A browser must not be the place this vocabulary is defined.
   */
  @Get('capabilities')
  @ApiOperation({
    summary:
      'Trigger events, trigger objects and action types the engine supports',
  })
  @RequirePermission('view', 'automation_workflows')
  capabilities() {
    return {
      triggerEvents: AUTOMATION_TRIGGER_EVENTS,
      triggerObjects: AUTOMATION_TRIGGER_OBJECTS,
      actionTypes: AUTOMATION_ACTION_TYPES,
      crmOnlyActions: CRM_ONLY_ACTIONS,
      configRequiredActions: CONFIG_REQUIRED_ACTIONS,
    };
  }

  @Get()
  @ApiOperation({ summary: 'List all workflows for the current tenant' })
  @RequirePermission('view', 'automation_workflows')
  findAll(@Query('status') status?: 'draft' | 'active' | 'paused') {
    if (status) {
      return this.service.findByStatus(status);
    }
    return this.service.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a workflow by ID' })
  @RequirePermission('view', 'automation_workflows')
  findById(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new workflow' })
  @RequirePermission('create', 'automation_workflows')
  create(@Body() dto: CreateWorkflowDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a workflow (nodes, edges, metadata)' })
  @RequirePermission('edit', 'automation_workflows')
  update(@Param('id') id: string, @Body() dto: UpdateWorkflowDto) {
    return this.service.update(id, dto);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Activate, pause, or revert workflow to draft' })
  // Separate from `edit`: this is the switch that starts a rule rewriting
  // production records, so a tenant can require a different person to throw it.
  @RequirePermission('activate', 'automation_workflows')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateWorkflowStatusDto) {
    return this.service.updateStatus(id, dto);
  }

  @Post(':id/dry-run')
  @ApiOperation({
    summary:
      'Evaluate the draft graph against a record without performing any side effect',
  })
  // The grant existed in the permission catalog with no route behind it, so the
  // only way to try a workflow was to publish it and mail real customers.
  @RequirePermission('test', 'automation_workflows')
  dryRunWorkflow(@Param('id') id: string, @Body() dto: DryRunWorkflowDto) {
    return this.dryRun.run(id, dto);
  }

  @Post(':id/duplicate')
  @ApiOperation({ summary: 'Deep-clone a workflow' })
  @RequirePermission('create', 'automation_workflows')
  duplicate(@Param('id') id: string) {
    return this.service.duplicate(id);
  }

  @Post(':id/publish')
  @ApiOperation({
    summary:
      'Publish a workflow — snapshot draft to published for immutable execution',
  })
  // Maker-checker seam: `edit` changes the draft, `publish` is what makes it
  // the version the engine executes.
  @RequirePermission('publish', 'automation_workflows')
  publish(@Param('id') id: string) {
    return this.service.publish(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a workflow' })
  @RequirePermission('delete', 'automation_workflows')
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
