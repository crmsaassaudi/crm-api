import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ContactSettingsService } from './contact-settings.service';

@ApiTags('Contact Settings')
@ApiBearerAuth()
@Controller({ path: 'contact-settings', version: '1' })
export class ContactSettingsController {
  constructor(private readonly service: ContactSettingsService) {}

  // ── Statuses ───────────────────────────────────────────────────────────
  @Get('statuses')
  findAllStatuses() {
    return this.service.findAllStatuses();
  }

  @Post('statuses')
  createStatus(@Body() body: any) {
    return this.service.createStatus(body);
  }

  @Patch('statuses/:id')
  updateStatus(@Param('id') id: string, @Body() body: any) {
    return this.service.updateStatus(id, body);
  }

  @Delete('statuses/:id')
  async deleteStatus(@Param('id') id: string): Promise<void> {
    await this.service.deleteStatus(id);
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

  // ── Lifecycle Stages ───────────────────────────────────────────────────
  @Get('lifecycle-stages')
  findAllLifecycleStages() {
    return this.service.findAllLifecycleStages();
  }

  @Post('lifecycle-stages')
  createLifecycleStage(@Body() body: any) {
    return this.service.createLifecycleStage(body);
  }

  @Patch('lifecycle-stages/:id')
  updateLifecycleStage(@Param('id') id: string, @Body() body: any) {
    return this.service.updateLifecycleStage(id, body);
  }

  @Delete('lifecycle-stages/:id')
  async deleteLifecycleStage(@Param('id') id: string): Promise<void> {
    await this.service.deleteLifecycleStage(id);
  }
}
