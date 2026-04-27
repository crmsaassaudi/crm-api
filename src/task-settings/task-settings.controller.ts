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
import { TaskSettingsService } from './task-settings.service';

@ApiTags('Task Settings')
@ApiBearerAuth()
@Controller({ path: 'task-settings', version: '1' })
export class TaskSettingsController {
  constructor(private readonly service: TaskSettingsService) {}

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

  // ── Categories ─────────────────────────────────────────────────────────
  @Get('categories')
  findAllCategories() {
    return this.service.findAllCategories();
  }

  @Post('categories')
  createCategory(@Body() body: any) {
    return this.service.createCategory(body);
  }

  @Patch('categories/:id')
  updateCategory(@Param('id') id: string, @Body() body: any) {
    return this.service.updateCategory(id, body);
  }

  @Delete('categories/:id')
  async deleteCategory(@Param('id') id: string): Promise<void> {
    await this.service.deleteCategory(id);
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
