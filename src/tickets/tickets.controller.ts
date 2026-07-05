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
import { ApiTags, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { DataMaskingInterceptor } from '../common/interceptors/data-masking.interceptor';
import { MaskedResource } from '../common/decorators/masked-resource.decorator';
import { SanitizeMaskedInputPipe } from '../common/pipes/sanitize-masked-input.pipe';
import { RequirePermission } from '../common/permissions';
import { StartTicketImportDto } from './dto/start-ticket-import.dto';
import { ExportRequestDto } from '../common/export';

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
@UseInterceptors(DataMaskingInterceptor)
@MaskedResource('Ticket')
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
  findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  @Patch(':id')
  @RequirePermission('edit', 'tickets')
  @UsePipes(new SanitizeMaskedInputPipe())
  update(@Param('id') id: string, @Body() data: UpdateTicketDto) {
    return this.service.update(id, data as Partial<Ticket>);
  }

  @Delete(':id')
  @RequirePermission('delete', 'tickets')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Post(':id/merge')
  @RequirePermission('edit', 'tickets')
  mergeTickets(
    @Param('id') targetId: string,
    @Body() body: { sourceId: string },
  ) {
    return this.service.mergeTickets(targetId, body.sourceId);
  }

  // ──────────────────────────── SLA PAUSE / RESUME ────────────────────────────

  @Post(':id/sla/pause')
  @RequirePermission('edit', 'tickets')
  pauseSla(@Param('id') id: string) {
    return this.service.pauseSla(id);
  }

  @Post(':id/sla/resume')
  @RequirePermission('edit', 'tickets')
  resumeSla(@Param('id') id: string) {
    return this.service.resumeSla(id);
  }

  // ──────────────────────────── DEAL LINK ────────────────────────────

  @Patch(':id/link-deal')
  @RequirePermission('edit', 'tickets')
  linkDeal(@Param('id') id: string, @Body() body: { dealId: string }) {
    return this.service.linkDeal(id, body.dealId);
  }

  @Delete(':id/unlink-deal')
  @RequirePermission('edit', 'tickets')
  unlinkDeal(@Param('id') id: string) {
    return this.service.unlinkDeal(id);
  }

  @Get('by-deal/:dealId')
  @RequirePermission('view', 'tickets')
  findByDeal(@Param('dealId') dealId: string) {
    return this.service.findByDeal(dealId);
  }

  // ──────────────────────────── PARENT/CHILD HIERARCHY ─────────────────────

  @Patch(':id/set-parent')
  @RequirePermission('edit', 'tickets')
  setParent(@Param('id') id: string, @Body() body: { parentTicketId: string }) {
    return this.service.setParent(id, body.parentTicketId);
  }

  @Delete(':id/remove-parent')
  @RequirePermission('edit', 'tickets')
  removeParent(@Param('id') id: string) {
    return this.service.removeParent(id);
  }

  @Get(':id/children')
  @RequirePermission('view', 'tickets')
  getChildren(@Param('id') id: string) {
    return this.service.getChildren(id);
  }

  // ──────────────────────────── IMPORT ────────────────────────────

  @Post('import-upload')
  @RequirePermission('create', 'tickets')
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

  // ──────────────────────────── EXPORT ────────────────────────────

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
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }
}
