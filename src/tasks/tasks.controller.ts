import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseInterceptors,
  UsePipes,
} from '@nestjs/common';
import { TasksService } from './tasks.service';
import { Task } from './domain/task';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DataMaskingInterceptor } from '../common/interceptors/data-masking.interceptor';
import { MaskedResource } from '../common/decorators/masked-resource.decorator';
import { SanitizeMaskedInputPipe } from '../common/pipes/sanitize-masked-input.pipe';
import { RequirePermission } from '../common/permissions';

@ApiTags('Tasks')
@ApiBearerAuth()
@UseInterceptors(DataMaskingInterceptor)
@MaskedResource('Task')
@Controller({
  path: 'tasks',
  version: '1',
})
export class TasksController {
  constructor(private readonly service: TasksService) {}

  @Post()
  @RequirePermission('create', 'tasks')
  create(@Body() data: Partial<Task>) {
    return this.service.create(data);
  }

  @Get()
  @RequirePermission('view', 'tasks')
  findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  @Get(':id')
  @RequirePermission('view', 'tasks')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('edit', 'tasks')
  @UsePipes(new SanitizeMaskedInputPipe())
  update(@Param('id') id: string, @Body() data: Partial<Task>) {
    return this.service.update(id, data);
  }

  @Delete(':id')
  @RequirePermission('delete', 'tasks')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
