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
}
