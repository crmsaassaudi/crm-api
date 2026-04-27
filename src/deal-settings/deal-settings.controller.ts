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

@ApiTags('Deal Settings')
@ApiBearerAuth()
@Controller({ path: 'deal-settings', version: '1' })
export class DealSettingsController {
  constructor(private readonly service: DealSettingsService) {}

  // ── Stages ─────────────────────────────────────────────────────────────
  @Get('stages')
  findAllStages(@Query('pipelineId') pipelineId?: string) {
    return this.service.findAllStages(pipelineId);
  }

  @Post('stages')
  createStage(@Body() body: any) {
    return this.service.createStage(body);
  }

  @Patch('stages/:id')
  updateStage(@Param('id') id: string, @Body() body: any) {
    return this.service.updateStage(id, body);
  }

  @Delete('stages/:id')
  async deleteStage(@Param('id') id: string): Promise<void> {
    await this.service.deleteStage(id);
  }

  // ── Sources ────────────────────────────────────────────────────────────
  @Get('sources')
  findAllSources() {
    return this.service.findAllSources();
  }

  @Post('sources')
  createSource(@Body() body: any) {
    return this.service.createSource(body);
  }

  @Patch('sources/:id')
  updateSource(@Param('id') id: string, @Body() body: any) {
    return this.service.updateSource(id, body);
  }

  @Delete('sources/:id')
  async deleteSource(@Param('id') id: string): Promise<void> {
    await this.service.deleteSource(id);
  }
}
