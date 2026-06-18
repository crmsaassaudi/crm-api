import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DealSettingsService } from './deal-settings.service';
import {
  CreateDealSourceDto,
  CreateDealStageDto,
  UpdateDealSourceDto,
  UpdateDealStageDto,
} from './dto/deal-settings.dto';
import { RequirePermission } from '../common/permissions/permission.decorator';

@ApiTags('Deal Settings')
@ApiBearerAuth()
@Controller({ path: 'deal-settings', version: '1' })
export class DealSettingsController {
  constructor(private readonly service: DealSettingsService) {}

  // ── Stages ─────────────────────────────────────────────────────────────
  @Get('stages')
  @RequirePermission('view', 'settings')
  findAllStages(@Query('pipelineId') pipelineId?: string) {
    return this.service.findAllStages(pipelineId);
  }

  @Post('stages')
  @RequirePermission('manage_system', 'settings')
  createStage(@Body() body: CreateDealStageDto) {
    return this.service.createStage(body);
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

  // ── Sources ────────────────────────────────────────────────────────────
  @Get('sources')
  @RequirePermission('view', 'settings')
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

  // ── Pipelines ──────────────────────────────────────────────────────────

  @Get('pipelines')
  @RequirePermission('view', 'settings')
  findAllPipelines() {
    return this.service.findAllPipelines();
  }

  @Get('pipelines/:id')
  @RequirePermission('view', 'settings')
  findPipelineById(@Param('id') id: string) {
    return this.service.findPipelineById(id);
  }

  @Post('pipelines')
  @RequirePermission('manage_system', 'settings')
  createPipeline(
    @Body()
    body: {
      name: string;
      description?: string;
      color?: string;
      isDefault?: boolean;
      sortOrder?: number;
    },
  ) {
    return this.service.createPipeline(body);
  }

  @Patch('pipelines/:id')
  @RequirePermission('manage_system', 'settings')
  updatePipeline(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      description?: string;
      color?: string;
      sortOrder?: number;
      isDefault?: boolean;
    },
  ) {
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
