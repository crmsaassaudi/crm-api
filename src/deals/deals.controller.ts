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
import { DealsService } from './deals.service';
import { CreateDealDto } from './dto/create-deal.dto';
import { UpdateDealDto } from './dto/update-deal.dto';
import { Deal } from './domain/deal';
import {
  ApiTags,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { DataMaskingInterceptor } from '../common/interceptors/data-masking.interceptor';
import { MaskedResource } from '../common/decorators/masked-resource.decorator';
import { SanitizeMaskedInputPipe } from '../common/pipes/sanitize-masked-input.pipe';
import { RequirePermission } from '../common/permissions';
import { StartDealImportDto } from './dto/start-deal-import.dto';
import { ExportRequestDto } from '../common/export';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { IsString, IsOptional, IsEnum } from 'class-validator';

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

class CreateDealActivityDto {
  @ApiProperty({
    enum: ['note', 'call', 'meeting', 'email', 'task'],
    example: 'note',
  })
  @IsEnum(['note', 'call', 'meeting', 'email', 'task'])
  type: string;

  @ApiPropertyOptional({ example: 'Had discovery call, very interested.' })
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional()
  @IsOptional()
  metadata?: Record<string, any>;
}

@ApiTags('Deals')
@ApiBearerAuth()
@UseInterceptors(DataMaskingInterceptor)
@MaskedResource('Deal')
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

  @Patch(':id')
  @RequirePermission('edit', 'deals')
  @UsePipes(new SanitizeMaskedInputPipe())
  update(@Param('id') id: string, @Body() data: UpdateDealDto) {
    return this.service.update(id, data as Partial<Deal>);
  }

  @Delete(':id')
  @RequirePermission('delete', 'deals')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  // ──────────────────────────── TICKET LINK ────────────────────────────

  @Get(':id/tickets')
  @RequirePermission('view', 'deals')
  getLinkedTickets(@Param('id') id: string) {
    return this.service.getLinkedTickets(id);
  }

  // ──────────────────────────── IMPORT ────────────────────────────

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

  // ──────────────────────────── EXPORT ────────────────────────────

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
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  // ── Deal Activity Feed ─────────────────────────────────────────────────

  @Get(':id/activities')
  @RequirePermission('view', 'deals')
  async getActivities(
    @Param('id') id: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.activityLog.getFeed({
      targetType: 'Deal',
      targetId: id,
      type: type as any,
      limit: limit ? Number(limit) : 20,
      cursor,
    });
  }

  @Post(':id/activities')
  @RequirePermission('view', 'deals')
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
