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
import {
  CreateTaskCategoryDto,
  CreateTaskSourceDto,
  CreateTaskStatusDto,
  UpdateTaskCategoryDto,
  UpdateTaskSourceDto,
  UpdateTaskStatusDto,
} from './dto/task-settings.dto';
import { RequirePermission } from '../common/permissions/permission.decorator';

@ApiTags('Task Settings')
@ApiBearerAuth()
@Controller({ path: 'task-settings', version: '1' })
export class TaskSettingsController {
  constructor(private readonly service: TaskSettingsService) {}

  // ── Statuses ───────────────────────────────────────────────────────────
  @Get('statuses')
  @RequirePermission('view', 'settings')
  findAllStatuses() {
    return this.service.findAllStatuses();
  }

  @Post('statuses')
  @RequirePermission('manage_system', 'settings')
  createStatus(@Body() body: CreateTaskStatusDto) {
    return this.service.createStatus(body);
  }

  @Patch('statuses/:id')
  @RequirePermission('manage_system', 'settings')
  updateStatus(@Param('id') id: string, @Body() body: UpdateTaskStatusDto) {
    return this.service.updateStatus(id, body);
  }

  @Delete('statuses/:id')
  @RequirePermission('manage_system', 'settings')
  async deleteStatus(@Param('id') id: string): Promise<void> {
    await this.service.deleteStatus(id);
  }

  // ── Categories ─────────────────────────────────────────────────────────
  @Get('categories')
  @RequirePermission('view', 'settings')
  findAllCategories() {
    return this.service.findAllCategories();
  }

  @Post('categories')
  @RequirePermission('manage_system', 'settings')
  createCategory(@Body() body: CreateTaskCategoryDto) {
    return this.service.createCategory(body);
  }

  @Patch('categories/:id')
  @RequirePermission('manage_system', 'settings')
  updateCategory(
    @Param('id') id: string,
    @Body() body: UpdateTaskCategoryDto,
  ) {
    return this.service.updateCategory(id, body);
  }

  @Delete('categories/:id')
  @RequirePermission('manage_system', 'settings')
  async deleteCategory(@Param('id') id: string): Promise<void> {
    await this.service.deleteCategory(id);
  }

  // ── Sources ────────────────────────────────────────────────────────────
  @Get('sources')
  @RequirePermission('view', 'settings')
  findAllSources() {
    return this.service.findAllSources();
  }

  @Post('sources')
  @RequirePermission('manage_system', 'settings')
  createSource(@Body() body: CreateTaskSourceDto) {
    return this.service.createSource(body);
  }

  @Patch('sources/:id')
  @RequirePermission('manage_system', 'settings')
  updateSource(@Param('id') id: string, @Body() body: UpdateTaskSourceDto) {
    return this.service.updateSource(id, body);
  }

  @Delete('sources/:id')
  @RequirePermission('manage_system', 'settings')
  async deleteSource(@Param('id') id: string): Promise<void> {
    await this.service.deleteSource(id);
  }
}
