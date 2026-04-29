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

@ApiTags('Automation Workflows')
@ApiBearerAuth()
@Controller({ path: 'automation-workflows', version: '1' })
export class AutomationWorkflowController {
  constructor(private readonly service: AutomationWorkflowService) {}

  @Get()
  @ApiOperation({ summary: 'List all workflows for the current tenant' })
  findAll(@Query('status') status?: 'draft' | 'active' | 'paused') {
    if (status) {
      return this.service.findByStatus(status);
    }
    return this.service.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a workflow by ID' })
  findById(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new workflow' })
  create(@Body() dto: CreateWorkflowDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a workflow (nodes, edges, metadata)' })
  update(@Param('id') id: string, @Body() dto: UpdateWorkflowDto) {
    return this.service.update(id, dto);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Activate, pause, or revert workflow to draft' })
  updateStatus(@Param('id') id: string, @Body() dto: UpdateWorkflowStatusDto) {
    return this.service.updateStatus(id, dto);
  }

  @Post(':id/duplicate')
  @ApiOperation({ summary: 'Deep-clone a workflow' })
  duplicate(@Param('id') id: string) {
    return this.service.duplicate(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a workflow' })
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
