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
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { TicketsService } from './tickets.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { Ticket } from './domain/ticket';
import {
  ApiTags,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
  ApiOkResponse,
} from '@nestjs/swagger';
import { FieldPolicyInterceptor } from '../object-manager/layout/field-policy.interceptor';
import { ObjectFieldPolicy } from '../object-manager/layout/object-field-policy.decorator';
import { SanitizeMaskedInputPipe } from '../common/pipes/sanitize-masked-input.pipe';
import { RequirePermission, UseAcl, LoadResource } from '../common/permissions';
import { StartTicketImportDto } from './dto/start-ticket-import.dto';
import { ExportRequestDto } from '../common/export';
import { Throttle } from '@nestjs/throttler';
import {
  BulkTagTicketsDto,
  JobListQueryDto,
  LinkTicketDealDto,
  MergeTicketDto,
  PageQueryDto,
  SetTicketParentDto,
  TicketListQueryDto,
} from './dto/ticket-operations.dto';
import { TICKET_IMPORT_MAX_FILE_BYTES } from './tickets.constants';

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

@ApiTags('Tickets')
@ApiBearerAuth()
@UseInterceptors(FieldPolicyInterceptor)
@ObjectFieldPolicy('Ticket')
@Controller({
  path: 'tickets',
  version: '1',
})
export class TicketsController {
  constructor(private readonly service: TicketsService) {}

  @Post()
  @RequirePermission('create', 'tickets')
  create(@Body() data: CreateTicketDto) {
    return this.service.create(data as Partial<Ticket>);
  }

  @Get()
  @RequirePermission('view', 'tickets')
  findAll(@Query() query: TicketListQueryDto) {
    return this.service.findAll(query);
  }

  /**
   * `tickets:edit` is the floor, not the whole story: resolving, reopening and
   * reassigning are checked inside the service, because whether they apply
   * depends on the payload rather than on the route.
   */
  @Patch(':id')
  @RequirePermission('edit', 'tickets')
  @UseAcl('edit', 'tickets')
  @LoadResource('tickets')
  @UsePipes(new SanitizeMaskedInputPipe())
  update(@Param('id') id: string, @Body() data: UpdateTicketDto) {
    return this.service.update(id, data as Partial<Ticket>);
  }

  // RECYCLE BIN
  //
  // Declared BEFORE the `:id` routes — Nest matches in declaration order, and
  // `recycle-bin` would otherwise be captured as an id.

  @ApiOkResponse({ description: 'Soft-deleted tickets awaiting purge' })
  @Get('recycle-bin')
  @RequirePermission('view', 'tickets')
  listDeleted(@Query() query: PageQueryDto) {
    return this.service.listDeleted(query);
  }

  // Restoring re-exposes a record, so it takes `delete` — the same capability that
  // removed it — rather than `edit`. Record-level ACL as well: you may only bring
  // back a record you could have seen. The PIP's loader reads with `findById` and no
  // soft-delete predicate, so it hydrates the archived document and the
  // owner/org-unit conditions evaluate against the record as it was.
  @Post(':id/restore')
  @RequirePermission('delete', 'tickets')
  @UseAcl('delete', 'tickets')
  @LoadResource('tickets')
  restore(@Param('id') id: string) {
    return this.service.restore(id);
  }

  @Delete(':id')
  @RequirePermission('delete', 'tickets')
  @UseAcl('delete', 'tickets')
  @LoadResource('tickets')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('bulk-tag')
  @RequirePermission('edit', 'tickets')
  bulkTag(@Body() body: BulkTagTicketsDto) {
    return this.service.bulkTagTickets(body);
  }

  /**
   * Requires `delete`: `mergeTickets` soft-deletes the source ticket, so gating this on
   * `edit` made merge a deletion path that skips the delete check. The same rule now
   * applies to contact and account merge.
   */
  @Post(':id/merge')
  @RequirePermission('delete', 'tickets')
  @UseAcl('delete', 'tickets')
  @LoadResource('tickets')
  mergeTickets(@Param('id') targetId: string, @Body() body: MergeTicketDto) {
    return this.service.mergeTickets(targetId, body.sourceId);
  }

  // SLA PAUSE / RESUME

  @Post(':id/sla/pause')
  @RequirePermission('edit', 'tickets')
  @UseAcl('edit', 'tickets')
  @LoadResource('tickets')
  pauseSla(@Param('id') id: string) {
    return this.service.pauseSla(id);
  }

  @Post(':id/sla/resume')
  @RequirePermission('edit', 'tickets')
  @UseAcl('edit', 'tickets')
  @LoadResource('tickets')
  resumeSla(@Param('id') id: string) {
    return this.service.resumeSla(id);
  }

  @Patch(':id/link-deal')
  @RequirePermission('edit', 'tickets')
  @UseAcl('edit', 'tickets')
  @LoadResource('tickets')
  linkDeal(@Param('id') id: string, @Body() body: LinkTicketDealDto) {
    return this.service.linkDeal(id, body.dealId);
  }

  @Delete(':id/unlink-deal')
  @RequirePermission('edit', 'tickets')
  @UseAcl('edit', 'tickets')
  @LoadResource('tickets')
  unlinkDeal(@Param('id') id: string) {
    return this.service.unlinkDeal(id);
  }

  @Get('by-deal/:dealId')
  @RequirePermission('view', 'tickets')
  @UseAcl('view', 'deals', 'dealId')
  @LoadResource('deals')
  findByDeal(@Param('dealId') dealId: string) {
    return this.service.findByDeal(dealId);
  }

  // PARENT/CHILD HIERARCHY

  @Patch(':id/set-parent')
  @RequirePermission('edit', 'tickets')
  @UseAcl('edit', 'tickets')
  @LoadResource('tickets')
  setParent(@Param('id') id: string, @Body() body: SetTicketParentDto) {
    return this.service.setParent(id, body.parentTicketId);
  }

  @Delete(':id/remove-parent')
  @RequirePermission('edit', 'tickets')
  @UseAcl('edit', 'tickets')
  @LoadResource('tickets')
  removeParent(@Param('id') id: string) {
    return this.service.removeParent(id);
  }

  @Get(':id/children')
  @RequirePermission('view', 'tickets')
  @UseAcl('view', 'tickets')
  @LoadResource('tickets')
  getChildren(@Param('id') id: string) {
    return this.service.getChildren(id);
  }

  @Post('import-upload')
  @RequirePermission('create', 'tickets')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: TICKET_IMPORT_MAX_FILE_BYTES, files: 1 },
    }),
  )
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
  @RequirePermission('create', 'tickets')
  startImport(@Body() dto: StartTicketImportDto) {
    return this.service.startImport(dto);
  }

  @Get('import-status/:jobId')
  @RequirePermission('view', 'tickets')
  getImportStatus(@Param('jobId') jobId: string) {
    return this.service.getImportStatus(jobId);
  }

  @Get('import-jobs')
  @RequirePermission('view', 'tickets')
  listImportJobs(@Query() query: JobListQueryDto) {
    return this.service.listImportJobs(query);
  }

  @Get('import-jobs/:id')
  @RequirePermission('view', 'tickets')
  getImportJobDetail(@Param('id') id: string) {
    return this.service.getImportJobDetail(id);
  }

  @Get('import-report/:token')
  @RequirePermission('view', 'tickets')
  async getImportReport(@Param('token') token: string, @Res() res: Response) {
    const { buffer, filename } = await this.service.getImportReport(token);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(buffer);
  }

  @Post('export')
  @RequirePermission('export', 'tickets')
  exportTickets(@Body() body: ExportRequestDto) {
    return this.service.exportTickets(body || {});
  }

  @Get('export-status/:jobId')
  @RequirePermission('export', 'tickets')
  getExportStatus(@Param('jobId') jobId: string) {
    return this.service.getExportStatus(jobId);
  }

  @Get('export-jobs')
  @RequirePermission('export', 'tickets')
  listExportJobs(@Query() query: JobListQueryDto) {
    return this.service.listExportJobs(query);
  }

  @Post('export-jobs/:jobId/cancel')
  @RequirePermission('export', 'tickets')
  cancelExport(@Param('jobId') jobId: string) {
    return this.service.cancelExport(jobId);
  }

  @Get('export-download/:token')
  @RequirePermission('export', 'tickets')
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
  @RequirePermission('view', 'tickets')
  @UseAcl('view', 'tickets')
  @LoadResource('tickets')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }
}
