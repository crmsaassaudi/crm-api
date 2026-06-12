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
import {
  CreateWorkflowDto,
  UpdateWorkflowDto,
  UpdateWorkflowStatusDto,
} from './dto/workflow.dto';
import { RequirePermission } from '../common/permissions/permission.decorator';

@ApiTags('Automation Workflows')
@ApiBearerAuth()
@Controller({ path: 'automation-workflows', version: '1' })
export class AutomationWorkflowController {
  constructor(private readonly service: AutomationWorkflowService) {}

  @Get()
  @ApiOperation({ summary: 'List all workflows for the current tenant' })
  @RequirePermission('view', 'settings')
  findAll(@Query('status') status?: 'draft' | 'active' | 'paused') {
    if (status) {
      return this.service.findByStatus(status);
    }
    return this.service.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a workflow by ID' })
  @RequirePermission('view', 'settings')
  findById(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new workflow' })
  @RequirePermission('manage_system', 'settings')
  create(@Body() dto: CreateWorkflowDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a workflow (nodes, edges, metadata)' })
  @RequirePermission('manage_system', 'settings')
  update(@Param('id') id: string, @Body() dto: UpdateWorkflowDto) {
    return this.service.update(id, dto);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Activate, pause, or revert workflow to draft' })
  @RequirePermission('manage_system', 'settings')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateWorkflowStatusDto) {
    return this.service.updateStatus(id, dto);
  }

  @Post(':id/duplicate')
  @ApiOperation({ summary: 'Deep-clone a workflow' })
  @RequirePermission('manage_system', 'settings')
  duplicate(@Param('id') id: string) {
    return this.service.duplicate(id);
  }

  @Post(':id/publish')
  @ApiOperation({
    summary:
      'Publish a workflow — snapshot draft to published for immutable execution',
  })
  @RequirePermission('manage_system', 'settings')
  publish(@Param('id') id: string) {
    return this.service.publish(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a workflow' })
  @RequirePermission('manage_system', 'settings')
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
