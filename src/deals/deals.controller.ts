import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
  UsePipes,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { DealsService } from './deals.service';
import { CreateDealDto } from './dto/create-deal.dto';
import { UpdateDealDto } from './dto/update-deal.dto';
import { Deal } from './domain/deal';
import { FieldPolicyInterceptor } from '../object-manager/layout/field-policy.interceptor';
import { ObjectFieldPolicy } from '../object-manager/layout/object-field-policy.decorator';
import { SanitizeMaskedInputPipe } from '../common/pipes/sanitize-masked-input.pipe';
import {
  LoadResource,
  RequirePermission,
  SensitiveResource,
  UseAcl,
} from '../common/permissions';
import { StartDealImportDto } from './dto/start-deal-import.dto';
import { BulkDealIdsDto, BulkUpdateDealsDto } from './dto/bulk-deal.dto';
import { BulkTagDealsDto } from './dto/bulk-tag-deals.dto';
import {
  BoardColumnQueryDto,
  BoardSummaryQueryDto,
} from './dto/board-query.dto';
import { ExportRequestDto } from '../common/export';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreateDealActivityDto } from './dto/create-deal-activity.dto';

/** Map a safe file extension to its HTTP Content-Type. */
const resolveContentType = (ext?: string): string => {
  if (ext === 'xlsx') {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (ext === 'gz') return 'application/gzip';
  return 'text/csv; charset=utf-8';
};

@ApiTags('Deals')
@ApiBearerAuth()
@UseInterceptors(FieldPolicyInterceptor)
@ObjectFieldPolicy('Deal')
@SensitiveResource('deals')
@Controller({ path: 'deals', version: '1' })
export class DealsController {
  constructor(
    private readonly service: DealsService,
    private readonly activityLog: ActivityLogService,
  ) {}

  // Collection routes are declared BEFORE the `:id` routes — Nest matches in
  // declaration order, and `board`/`bulk`/`recycle-bin` would otherwise be
  // captured as an id.

  @Post()
  @RequirePermission('create', 'deals')
  @UsePipes(new SanitizeMaskedInputPipe())
  create(@Body() data: CreateDealDto) {
    return this.service.create(data as Partial<Deal>);
  }

  @Get()
  @RequirePermission('view', 'deals')
  findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  @ApiOkResponse({
    description:
      'Keyset-paginated deal list. Pass the response nextCursor back as ?cursor= for the next page.',
  })
  @Get('list-cursor')
  @RequirePermission('view', 'deals')
  findAllCursor(@Query() query: any) {
    return this.service.findAllCursor(query);
  }

  // BOARD
  //
  // Two endpoints, because a Kanban column and its header have different shapes:
  // the header needs an exact count and sum over the whole stage, the column
  // needs a page of cards. Deriving both in the browser from one page of deals —
  // which is what the board used to do — makes the header lie at any real volume.

  @ApiOkResponse({
    description: 'Per-stage deal count and value for one pipeline',
  })
  @Get('board')
  @RequirePermission('view', 'deals')
  getBoardSummary(@Query() query: BoardSummaryQueryDto) {
    return this.service.getBoardSummary(query);
  }

  @ApiOkResponse({ description: 'One keyset-paginated board column' })
  @Get('board/column')
  @RequirePermission('view', 'deals')
  getBoardColumn(@Query() query: BoardColumnQueryDto) {
    return this.service.getBoardColumn(query);
  }

  // BULK
  //
  // Each takes the same permission as its single-record equivalent and enforces
  // record-level scope per id inside the service (every id runs through the
  // normal update()/remove() path). Ids the caller cannot see, or that fail a
  // business rule, come back in `skipped` rather than failing the whole request.

  @ApiOkResponse({ description: 'Per-id outcome of the bulk update' })
  @Patch('bulk')
  @RequirePermission('edit', 'deals')
  @UsePipes(new SanitizeMaskedInputPipe())
  bulkUpdate(@Body() body: BulkUpdateDealsDto) {
    return this.service.bulkUpdate(body);
  }

  @ApiOkResponse({ description: 'Per-id outcome of the bulk delete' })
  // POST, not DELETE: a body on DELETE is legal but poorly supported by proxies
  // and client libraries, and a list of ids does not belong in a query string.
  @Post('bulk-delete')
  @RequirePermission('delete', 'deals')
  bulkRemove(@Body() body: BulkDealIdsDto) {
    return this.service.bulkRemove(body.ids);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('bulk-tag')
  @RequirePermission('edit', 'deals')
  bulkTag(@Body() body: BulkTagDealsDto) {
    return this.service.bulkTagDeals(body);
  }

  // RECYCLE BIN

  @ApiOkResponse({ description: 'Soft-deleted deals awaiting purge' })
  @Get('recycle-bin')
  @RequirePermission('view', 'deals')
  listDeleted(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.service.listDeleted({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // IMPORT / EXPORT

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
    res.setHeader(
      'Content-Type',
      resolveContentType(safeFilename.split('.').pop()?.toLowerCase()),
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeFilename}"`,
    );
    res.setHeader('Content-Length', String(file.buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.end(file.buffer);
  }

  // RECORD ROUTES

  @Patch(':id')
  @RequirePermission('edit', 'deals')
  @UseAcl('edit', 'deals')
  @LoadResource('deals')
  @UsePipes(new SanitizeMaskedInputPipe())
  update(@Param('id') id: string, @Body() data: UpdateDealDto) {
    return this.service.update(id, data as Partial<Deal>);
  }

  // Restoring re-exposes a record, so it takes `delete` — the same capability
  // that removed it — rather than `edit`, plus record-level ACL: you may only
  // bring back a record you could have seen.
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

  @Get(':id/tickets')
  @RequirePermission('view', 'deals')
  @UseAcl('view', 'deals')
  @LoadResource('deals')
  getLinkedTickets(@Param('id') id: string) {
    return this.service.getLinkedTickets(id);
  }

  @Get(':id')
  @RequirePermission('view', 'deals')
  @UseAcl('view', 'deals')
  @LoadResource('deals')
  async findOne(@Param('id') id: string) {
    const deal = await this.service.findOne(id);
    if (!deal) throw new NotFoundException(`Deal ${id} not found`);
    return deal;
  }

  // ACTIVITY FEED

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
    const activity = await this.activityLog.create({
      targetType: 'Deal',
      targetId: id,
      event: dto.type,
      payload: { content: dto.content, ...(dto.metadata ?? {}) },
    });
    // Logging a call is the clearest signal a deal is alive; without this the
    // stale-deal view keeps flagging deals somebody worked this morning.
    await this.service.touchActivity(id);
    return activity;
  }
}
