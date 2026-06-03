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
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { ContactsService } from './contacts.service';
import { Contact } from './domain/contact';
import { DataMaskingInterceptor } from '../common/interceptors/data-masking.interceptor';
import { MaskedResource } from '../common/decorators/masked-resource.decorator';
import { SanitizeMaskedInputPipe } from '../common/pipes/sanitize-masked-input.pipe';
import {
  ApiTags,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { QueryContactDto } from './dto/query-contact.dto';
import { CheckDuplicateContactDto } from './dto/check-duplicate-contact.dto';
import { ExportContactsDto } from './dto/export-contacts.dto';
import { StartImportDto } from './dto/start-import.dto';
import { IMPORT_MAX_FILE_BYTES } from './contacts.constants';
import { ChangeStageDto } from './dto/change-stage.dto';
import { SubResourceQueryDto } from './dto/sub-resource-query.dto';
import { ListViewsService } from '../list-views/list-views.service';
import { RequirePermission } from '../common/permissions';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { NotesService } from '../notes/notes.service';
import { CreateNoteDto } from '../notes/dto/create-note.dto';
import { TasksService } from '../tasks/tasks.service';
import { TicketsService } from '../tickets/tickets.service';

@ApiTags('Contacts')
@ApiBearerAuth()
@UseInterceptors(DataMaskingInterceptor)
@Controller({
  path: 'contacts',
  version: '1',
})
export class ContactsController {
  constructor(
    private readonly service: ContactsService,
    private readonly listViewsService: ListViewsService,
    private readonly activityLogService: ActivityLogService,
    private readonly notesService: NotesService,
    private readonly tasksService: TasksService,
    private readonly ticketsService: TicketsService,
  ) {}

  @ApiCreatedResponse({ type: Contact })
  @Post()
  @RequirePermission('create', 'contacts')
  @MaskedResource('Contact')
  create(@Body() data: CreateContactDto) {
    return this.service.create(data);
  }

  @ApiOkResponse({ type: [Contact] })
  @Get()
  @RequirePermission('view', 'contacts')
  @MaskedResource('Contact')
  async findAll(@Query() query: QueryContactDto) {
    const result = await this.service.findAll(query);

    // Attach view metadata if viewId is provided
    if (query?.viewId) {
      try {
        const view = await this.listViewsService.getViewById(query.viewId);
        return {
          ...result,
          viewMetadata: {
            viewId: view.id,
            viewName: view.name,
            columns: view.columns,
          },
        };
      } catch {
        // View not found — return data without metadata
      }
    }

    return result;
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('check-duplicate')
  @RequirePermission('view', 'contacts')
  checkDuplicate(@Query() query: CheckDuplicateContactDto) {
    return this.service.checkDuplicate(query);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('export')
  @RequirePermission('export', 'contacts')
  exportContacts(@Body() body: ExportContactsDto) {
    return this.service.exportContacts(body || {});
  }

  @Get('export-status/:jobId')
  @RequirePermission('export', 'contacts')
  getExportStatus(@Param('jobId') jobId: string) {
    return this.service.getExportStatus(jobId);
  }

  @Get('export-download/:token')
  @RequirePermission('export', 'contacts')
  async downloadExport(@Param('token') token: string, @Res() res: Response) {
    const file = await this.service.getExportDownload(token);
    // Sanitize filename to prevent header injection (RFC 5987)
    const safeFilename = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeFilename}"`,
    );
    res.setHeader('Content-Length', String(file.buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.end(file.buffer);
  }

  // ──────────────────────────── CONTACT IMPORT ────────────────────────────

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('import-upload')
  @RequirePermission('create', 'contacts')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: IMPORT_MAX_FILE_BYTES },
    }),
  )
  uploadImportFile(@UploadedFile() file: Express.Multer.File) {
    return this.service.uploadImportFile(file);
  }

  // Tighter than export (limit:10) — a single import job is far heavier.
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('import')
  @RequirePermission('create', 'contacts')
  startImport(@Body() body: StartImportDto) {
    return this.service.startImport(body);
  }

  @Get('import-status/:jobId')
  @RequirePermission('create', 'contacts')
  getImportStatus(@Param('jobId') jobId: string) {
    return this.service.getImportStatus(jobId);
  }

  @Get('import-jobs')
  @RequirePermission('create', 'contacts')
  listImportJobs(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    return this.service.listImportJobs({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      status,
    });
  }

  @Get('import-jobs/:id')
  @RequirePermission('create', 'contacts')
  getImportJobDetail(@Param('id') id: string) {
    return this.service.getImportJobDetail(id);
  }

  @Get('import-report/:token')
  @RequirePermission('create', 'contacts')
  async downloadImportReport(
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    const file = await this.service.getImportReport(token);
    const safeFilename = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeFilename}"`,
    );
    res.setHeader('Content-Length', String(file.buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.end(file.buffer);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('bulk-tag')
  @RequirePermission('edit', 'contacts')
  bulkTag(@Body() body: { contactIds: string[]; tags: string[] }) {
    return this.service.bulkTagContacts(body);
  }

  @Post(':id/merge')
  @RequirePermission('edit', 'contacts')
  mergeContacts(@Param('id') id: string, @Query('targetId') targetId: string) {
    return this.service.mergeContacts(id, targetId);
  }

  @Post(':id/unmask-fields')
  @RequirePermission('unmask', 'contacts')
  unmaskFields(@Param('id') id: string, @Body() body: { fields?: string[] }) {
    return this.service.unmaskFields(id, body?.fields);
  }

  @Get(':id/activities')
  @RequirePermission('view', 'contacts')
  getActivities(@Param('id') id: string, @Query() query: SubResourceQueryDto) {
    return this.activityLogService.getFeed({
      targetType: 'contact',
      targetId: id,
      type: query?.type as any,
      limit: query?.limit,
      cursor: query?.cursor,
    });
  }

  @Get(':id/notes')
  @RequirePermission('view', 'contacts')
  getNotes(@Param('id') id: string, @Query() query: SubResourceQueryDto) {
    return this.notesService.findByContact(id, query);
  }

  @Post(':id/notes')
  @RequirePermission('edit', 'contacts')
  createNote(@Param('id') id: string, @Body() body: CreateNoteDto) {
    return this.notesService.createForContact(id, body);
  }

  @Delete(':id/notes/:noteId')
  @RequirePermission('delete', 'contacts')
  deleteContactNote(@Param('noteId') noteId: string) {
    return this.notesService.delete(noteId);
  }

  @Get(':id/tasks')
  @RequirePermission('view', 'tasks')
  getTasks(@Param('id') id: string, @Query() query: SubResourceQueryDto) {
    return this.tasksService.findAll({ ...query, contactId: id });
  }

  @Get(':id/tickets')
  @RequirePermission('view', 'tickets')
  getTickets(@Param('id') id: string, @Query() query: SubResourceQueryDto) {
    return this.ticketsService.findAll({ ...query, contactId: id });
  }

  @ApiOkResponse({ type: Contact })
  @Get(':id')
  @RequirePermission('view', 'contacts')
  @MaskedResource('Contact') // Fallback to Contact if specific resource not identified
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @ApiOkResponse({ type: Contact })
  @Patch(':id')
  @RequirePermission('edit', 'contacts')
  @UsePipes(new SanitizeMaskedInputPipe())
  @MaskedResource('Contact')
  update(@Param('id') id: string, @Body() data: UpdateContactDto) {
    return this.service.update(id, data);
  }

  @Delete(':id')
  @RequirePermission('delete', 'contacts')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Post(':id/change-stage')
  @RequirePermission('edit', 'contacts')
  changeStage(@Param('id') id: string, @Body() body: ChangeStageDto) {
    return this.service.changeStage(id, body.stage, body);
  }

  @ApiOkResponse({ description: 'Stage transition history for a contact' })
  @Get(':id/stage-history')
  @RequirePermission('view', 'contacts')
  getStageHistory(@Param('id') id: string) {
    return this.service.getStageHistory(id);
  }

  /**
   * Link a new omni-channel identity to an existing contact.
   * Body: { channelType: string, senderId: string }
   */
  @Post(':id/merge-identity')
  @RequirePermission('edit', 'contacts')
  @ApiOkResponse({ type: Contact })
  mergeIdentity(
    @Param('id') id: string,
    @Body() body: { channelType: string; senderId: string },
  ) {
    return this.service.mergeIdentity(id, body);
  }
}
