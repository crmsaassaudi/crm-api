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
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { ApiTags, ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import { DataMaskingInterceptor } from '../common/interceptors/data-masking.interceptor';
import { MaskedResource } from '../common/decorators/masked-resource.decorator';
import { SanitizeMaskedInputPipe } from '../common/pipes/sanitize-masked-input.pipe';
import { RequirePermission, UseAcl, LoadResource } from '../common/permissions';

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
  create(@Body() data: CreateTaskDto) {
    return this.service.create(data);
  }

  @Get()
  @RequirePermission('view', 'tasks')
  findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  // ──────────────────────── RECYCLE BIN ────────────────────────
  //
  // Declared BEFORE the `:id` routes — Nest matches in declaration order, and
  // `recycle-bin` would otherwise be captured as an id.

  @ApiOkResponse({ description: 'Soft-deleted tasks awaiting purge' })
  @Get('recycle-bin')
  @RequirePermission('view', 'tasks')
  listDeleted(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.service.listDeleted({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  // Restoring re-exposes a record, so it takes `delete` — the same capability that
  // removed it — rather than `edit`. Record-level ACL as well: you may only bring
  // back a record you could have seen. The PIP's loader reads with `findById` and no
  // soft-delete predicate, so it hydrates the archived document and the
  // owner/org-unit conditions evaluate against the record as it was.
  @Post(':id/restore')
  @RequirePermission('delete', 'tasks')
  @UseAcl('delete', 'tasks')
  @LoadResource('tasks')
  restore(@Param('id') id: string) {
    return this.service.restore(id);
  }

  @Get(':id')
  @RequirePermission('view', 'tasks')
  @UseAcl('view', 'tasks')
  @LoadResource('tasks')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('edit', 'tasks')
  @UseAcl('edit', 'tasks')
  @LoadResource('tasks')
  @UsePipes(new SanitizeMaskedInputPipe())
  update(@Param('id') id: string, @Body() data: UpdateTaskDto) {
    return this.service.update(id, data);
  }

  @Delete(':id')
  @RequirePermission('delete', 'tasks')
  @UseAcl('delete', 'tasks')
  @LoadResource('tasks')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
