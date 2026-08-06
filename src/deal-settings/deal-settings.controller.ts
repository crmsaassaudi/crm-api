import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DealSettingsService } from './deal-settings.service';
import {
  CreateDealSourceDto,
  CreateDealStageDto,
  CreatePipelineDto,
  ReorderStagesDto,
  UpdateDealSourceDto,
  UpdateDealStageDto,
  UpdatePipelineDto,
} from './dto/deal-settings.dto';
import { RequirePermission } from '../common/permissions/permission.decorator';

/**
 * Reads take `deals:view`, writes take `settings:manage_system`.
 *
 * Reads used to take `settings:view`, which no sales role has — so the board, the
 * create form and the stage selector all asked for the stage list and got 403.
 * Stage and pipeline names are deal metadata: anyone who may see a deal must be
 * able to name the column it sits in.
 */
@ApiTags('Deal Settings')
@ApiBearerAuth()
@Controller({ path: 'deal-settings', version: '1' })
export class DealSettingsController {
  constructor(private readonly service: DealSettingsService) {}

  // Stages

  @Get('stages')
  @RequirePermission('view', 'deals')
  findAllStages(@Query('pipelineId') pipelineId?: string) {
    return this.service.findAllStages(pipelineId);
  }

  @Post('stages')
  @RequirePermission('manage_system', 'settings')
  createStage(@Body() body: CreateDealStageDto) {
    return this.service.createStage(body);
  }

  @Patch('stages/reorder/:pipelineId')
  @RequirePermission('manage_system', 'settings')
  reorderStages(
    @Param('pipelineId') pipelineId: string,
    @Body() body: ReorderStagesDto,
  ) {
    return this.service.reorderStages(pipelineId, body.stageIds);
  }

  @Patch('stages/:id')
  @RequirePermission('manage_system', 'settings')
  updateStage(@Param('id') id: string, @Body() body: UpdateDealStageDto) {
    return this.service.updateStage(id, body);
  }

  @Delete('stages/:id')
  @RequirePermission('manage_system', 'settings')
  async deleteStage(@Param('id') id: string): Promise<void> {
    await this.service.deleteStage(id);
  }

  // Sources

  @Get('sources')
  @RequirePermission('view', 'deals')
  findAllSources() {
    return this.service.findAllSources();
  }

  @Post('sources')
  @RequirePermission('manage_system', 'settings')
  createSource(@Body() body: CreateDealSourceDto) {
    return this.service.createSource(body);
  }

  @Patch('sources/:id')
  @RequirePermission('manage_system', 'settings')
  updateSource(@Param('id') id: string, @Body() body: UpdateDealSourceDto) {
    return this.service.updateSource(id, body);
  }

  @Delete('sources/:id')
  @RequirePermission('manage_system', 'settings')
  async deleteSource(@Param('id') id: string): Promise<void> {
    await this.service.deleteSource(id);
  }

  // Pipelines

  @Get('pipelines')
  @RequirePermission('view', 'deals')
  findAllPipelines() {
    return this.service.findAllPipelines();
  }

  @Get('pipelines/:id')
  @RequirePermission('view', 'deals')
  findPipelineById(@Param('id') id: string) {
    return this.service.findPipelineById(id);
  }

  @Post('pipelines')
  @RequirePermission('manage_system', 'settings')
  createPipeline(@Body() body: CreatePipelineDto) {
    return this.service.createPipeline(body);
  }

  @Patch('pipelines/:id')
  @RequirePermission('manage_system', 'settings')
  updatePipeline(@Param('id') id: string, @Body() body: UpdatePipelineDto) {
    return this.service.updatePipeline(id, body);
  }

  @Delete('pipelines/:id')
  @RequirePermission('manage_system', 'settings')
  async archivePipeline(@Param('id') id: string): Promise<void> {
    await this.service.archivePipeline(id);
  }

  @Post('pipelines/:id/set-default')
  @RequirePermission('manage_system', 'settings')
  setDefaultPipeline(@Param('id') id: string) {
    return this.service.updatePipeline(id, { isDefault: true });
  }
}
