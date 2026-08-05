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
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { TaskListQueryDto } from './dto/task-list-query.dto';
import { BulkTaskIdsDto, BulkUpdateTasksDto } from './dto/bulk-task.dto';
import { ApiTags, ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import { FieldPolicyInterceptor } from '../object-manager/layout/field-policy.interceptor';
import { ObjectFieldPolicy } from '../object-manager/layout/object-field-policy.decorator';
import { SanitizeMaskedInputPipe } from '../common/pipes/sanitize-masked-input.pipe';
import { RequirePermission, UseAcl, LoadResource } from '../common/permissions';
import { ExportRequestDto } from '../common/export';

function resolveContentType(ext: string | undefined): string {
  if (ext === 'xlsx') {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (ext === 'gz') return 'application/gzip';
  return 'text/csv; charset=utf-8';
}

@ApiTags('Tasks')
@ApiBearerAuth()
@UseInterceptors(FieldPolicyInterceptor)
@ObjectFieldPolicy('Task')
@Controller({
  path: 'tasks',
  version: '1',
})
export class TasksController {
  constructor(private readonly service: TasksService) {}

  @Post()
  @RequirePermission('create', 'tasks')
  // Sanitising on create as well as on update. It was only on `@Patch`, which left
  // the one route that introduces a record as the only one that could introduce a
  // masked value verbatim.
  @UsePipes(new SanitizeMaskedInputPipe())
  create(@Body() data: CreateTaskDto) {
    return this.service.create(data);
  }

  // BULK
  //
  // Before the `:id` routes, like `recycle-bin` — Nest matches in declaration
  // order and `bulk` would otherwise be captured as an id.
  //
  // Both take the same permission as their single-record equivalent, and enforce
  // record-level scope per id inside the service rather than through `@UseAcl`:
  // the guard evaluates one `:id` from the path, and these carry a list in the
  // body. Ids the caller cannot see come back in `skipped`, not as a failure of
  // the whole request.

  @ApiOkResponse({ description: 'Per-id outcome of the bulk update' })
  @Patch('bulk')
  @RequirePermission('edit', 'tasks')
  @UsePipes(new SanitizeMaskedInputPipe())
  bulkUpdate(@Body() body: BulkUpdateTasksDto) {
    return this.service.bulkUpdate(body);
  }

  @ApiOkResponse({ description: 'Per-id outcome of the bulk delete' })
  @Post('bulk-delete')
  // POST, not DELETE: a body on DELETE is legal but poorly supported by proxies
  // and client libraries, and a list of ids does not belong in a query string.
  @RequirePermission('delete', 'tasks')
  bulkRemove(@Body() body: BulkTaskIdsDto) {
    return this.service.bulkRemove(body.ids);
  }

  @Get()
  @RequirePermission('view', 'tasks')
  findAll(@Query() query: TaskListQueryDto) {
    return this.service.findAll(query);
  }

  @Post('export')
  @RequirePermission('export', 'tasks')
  exportTasks(@Body() body: ExportRequestDto) {
    return this.service.exportTasks(body || {});
  }

  @Get('export-status/:jobId')
  @RequirePermission('export', 'tasks')
  getExportStatus(@Param('jobId') jobId: string) {
    return this.service.getExportStatus(jobId);
  }

  @Get('export-jobs')
  @RequirePermission('export', 'tasks')
  listExportJobs(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    return this.service.listExportJobs({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      status,
    });
  }

  @Post('export-jobs/:jobId/cancel')
  @RequirePermission('export', 'tasks')
  cancelExport(@Param('jobId') jobId: string) {
    return this.service.cancelExport(jobId);
  }

  @Get('export-download/:token')
  @RequirePermission('export', 'tasks')
  async downloadExport(@Param('token') token: string, @Res() res: Response) {
    const file = await this.service.getExportDownload(token);
    const safeFilename = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const extension = safeFilename.split('.').pop()?.toLowerCase();
    res.setHeader('Content-Type', resolveContentType(extension));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeFilename}"`,
    );
    res.setHeader('Content-Length', String(file.buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.end(file.buffer);
  }

  // RECYCLE BIN
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
