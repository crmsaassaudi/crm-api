import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  Res,
  UseInterceptors,
  UsePipes,
  UploadedFile,
  NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { DealsService } from './deals.service';
import { CreateDealDto } from './dto/create-deal.dto';
import { UpdateDealDto } from './dto/update-deal.dto';
import { Deal } from './domain/deal';
import {
  ApiTags,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
  ApiOkResponse,
} from '@nestjs/swagger';
import { DataMaskingInterceptor } from '../common/interceptors/data-masking.interceptor';
import { MaskedResource } from '../common/decorators/masked-resource.decorator';
import { SanitizeMaskedInputPipe } from '../common/pipes/sanitize-masked-input.pipe';
import {
  RequirePermission,
  UseAcl,
  LoadResource,
  SensitiveResource,
} from '../common/permissions';
import { StartDealImportDto } from './dto/start-deal-import.dto';
import { BulkUpdateDealsDto, BulkDealIdsDto } from './dto/bulk-deal.dto';
import { ExportRequestDto } from '../common/export';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreateDealActivityDto } from './dto/create-deal-activity.dto';
import { Throttle } from '@nestjs/throttler';

/** Map a safe file extension to its HTTP Content-Type. */
function resolveContentType(ext: string | undefined): string {
  if (ext === 'xlsx') {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (ext === 'gz') {
    return 'application/gzip';
  }
  return 'text/csv; charset=utf-8';
}

@ApiTags('Deals')
@ApiBearerAuth()
@UseInterceptors(DataMaskingInterceptor)
@MaskedResource('Deal')
@SensitiveResource('deals')
@Controller({
  path: 'deals',
  version: '1',
})
export class DealsController {
  constructor(
    private readonly service: DealsService,
    private readonly activityLog: ActivityLogService,
  ) {}

  @Post()
  @RequirePermission('create', 'deals')
  create(@Body() data: CreateDealDto) {
    return this.service.create(data as Partial<Deal>);
  }

  @Get()
  @RequirePermission('view', 'deals')
  findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  // Keyset-pagination sibling of `GET /deals` — declared BEFORE `:id` for the
  // same reason as `bulk`/`recycle-bin`. Opt-in and additive: existing callers
  // of `GET /deals` are unaffected. See DealRepository.findManyByCursor for
  // why this exists (an index shaped for this was declared and unused).
  @ApiOkResponse({
    description:
      'Keyset-paginated deal list. Pass the response nextCursor back as ?cursor= for the next page.',
  })
  @Get('list-cursor')
  @RequirePermission('view', 'deals')
  findAllCursor(@Query() query: any) {
    return this.service.findAllCursor(query);
  }

  // BULK
  //
  // Declared BEFORE the `:id` routes — Nest matches in declaration order, and
  // `bulk`/`bulk-delete` would otherwise be captured as an id.
  //
  // Both take the same permission as their single-record equivalent, and
  // enforce record-level scope per id inside the service (each id runs
  // through the normal update()/remove() path) rather than through `@UseAcl`,
  // which evaluates a single `:id` from the path. Ids the caller cannot see,
  // or that fail a business rule (e.g. reopening a closed deal without
  // allowReopen), come back in `skipped`, not as a failure of the whole
  // request.

  @ApiOkResponse({ description: 'Per-id outcome of the bulk update' })
  @Patch('bulk')
  @RequirePermission('edit', 'deals')
  @UsePipes(new SanitizeMaskedInputPipe())
  bulkUpdate(@Body() body: BulkUpdateDealsDto) {
    return this.service.bulkUpdate(body);
  }

  @ApiOkResponse({ description: 'Per-id outcome of the bulk delete' })
  @Post('bulk-delete')
  // POST, not DELETE: a body on DELETE is legal but poorly supported by
  // proxies and client libraries, and a list of ids does not belong in a
  // query string.
  @RequirePermission('delete', 'deals')
  bulkRemove(@Body() body: BulkDealIdsDto) {
    return this.service.bulkRemove(body.ids);
  }

  @Patch(':id')
  @RequirePermission('edit', 'deals')
  @UseAcl('edit', 'deals')
  @LoadResource('deals')
  @UsePipes(new SanitizeMaskedInputPipe())
  update(@Param('id') id: string, @Body() data: UpdateDealDto) {
    return this.service.update(id, data as Partial<Deal>);
  }

  // RECYCLE BIN
  //
  // Declared BEFORE the `:id` routes — Nest matches in declaration order, and
  // `recycle-bin` would otherwise be captured as an id.

  @ApiOkResponse({ description: 'Soft-deleted deals awaiting purge' })
  @Get('recycle-bin')
  @RequirePermission('view', 'deals')
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
  @RequirePermission('delete', 'deals')
  @UseAcl('delete', 'deals')
  @LoadResource('deals')
  restore(@Param('id') id: string) {
    return this.service.restore(id);
  }

  @Delete(':id')
  @RequirePermission('delete', 'deals')
  @UseAcl('delete', 'deals')
  @LoadResource('deals')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('bulk-tag')
  @RequirePermission('edit', 'deals')
  bulkTag(@Body() body: { dealIds: string[]; tags: string[] }) {
    return this.service.bulkTagDeals(body);
  }

  // TICKET LINK

  @Get(':id/tickets')
  @RequirePermission('view', 'deals')
  @UseAcl('view', 'deals')
  @LoadResource('deals')
  getLinkedTickets(@Param('id') id: string) {
    return this.service.getLinkedTickets(id);
  }

  @Post('import-upload')
  @RequirePermission('create', 'deals')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  uploadImportFile(@UploadedFile() file: Express.Multer.File) {
    return this.service.uploadImportFile(file);
  }

  @Post('import')
  @RequirePermission('create', 'deals')
  startImport(@Body() dto: StartDealImportDto) {
    return this.service.startImport(dto);
  }

  @Get('import-status/:jobId')
  @RequirePermission('view', 'deals')
  getImportStatus(@Param('jobId') jobId: string) {
    return this.service.getImportStatus(jobId);
  }

  @Get('import-jobs')
  @RequirePermission('view', 'deals')
  listImportJobs(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    return this.service.listImportJobs({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      status,
    });
  }

  @Get('import-jobs/:id')
  @RequirePermission('view', 'deals')
  getImportJobDetail(@Param('id') id: string) {
    return this.service.getImportJobDetail(id);
  }

  @Get('import-report/:token')
  @RequirePermission('view', 'deals')
  async getImportReport(@Param('token') token: string, @Res() res: Response) {
    const { buffer, filename } = await this.service.getImportReport(token);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(buffer);
  }

  @Post('export')
  @RequirePermission('export', 'deals')
  exportDeals(@Body() body: ExportRequestDto) {
    return this.service.exportDeals(body || {});
  }

  @Get('export-status/:jobId')
  @RequirePermission('export', 'deals')
  getExportStatus(@Param('jobId') jobId: string) {
    return this.service.getExportStatus(jobId);
  }

  @Get('export-jobs')
  @RequirePermission('export', 'deals')
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
  @RequirePermission('export', 'deals')
  cancelExport(@Param('jobId') jobId: string) {
    return this.service.cancelExport(jobId);
  }

  @Get('export-download/:token')
  @RequirePermission('export', 'deals')
  async downloadExport(@Param('token') token: string, @Res() res: Response) {
    const file = await this.service.getExportDownload(token);
    const safeFilename = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const ext = safeFilename.split('.').pop()?.toLowerCase();
    const contentType = resolveContentType(ext);
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeFilename}"`,
    );
    res.setHeader('Content-Length', String(file.buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.end(file.buffer);
  }

  @Get(':id')
  @RequirePermission('view', 'deals')
  @UseAcl('view', 'deals')
  @LoadResource('deals')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  // Deal Activity Feed

  @Get(':id/activities')
  @RequirePermission('view', 'deals')
  @UseAcl('view', 'deals')
  @LoadResource('deals')
  async getActivities(
    @Param('id') id: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    if (!(await this.service.findOne(id))) {
      throw new NotFoundException(`Deal ${id} not found`);
    }
    return this.activityLog.getFeed({
      targetType: 'Deal',
      targetId: id,
      type: type as any,
      limit: limit ? Number(limit) : 20,
      cursor,
    });
  }

  @Post(':id/activities')
  @RequirePermission('edit', 'deals')
  @UseAcl('edit', 'deals')
  @LoadResource('deals')
  async createActivity(
    @Param('id') id: string,
    @Body() dto: CreateDealActivityDto,
  ) {
    return this.activityLog.create({
      targetType: 'Deal',
      targetId: id,
      event: dto.type,
      payload: {
        content: dto.content,
        ...(dto.metadata ?? {}),
      },
    });
  }
}
