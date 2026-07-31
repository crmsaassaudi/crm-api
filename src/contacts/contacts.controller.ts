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
  NotFoundException,
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
import { MergeContactsDto } from './dto/merge-contacts.dto';
import {
  ContactTimelineService,
  TimelineSource,
} from './timeline/contact-timeline.service';
import { ContactRelationsService } from './relations/contact-relations.service';
import { ContactIdentitySyncService } from './identities/contact-identity-sync.service';
import {
  SetIdentityConsentDto,
  SetIdentityDeliverabilityDto,
} from './dto/contact-identity.dto';
import {
  CreateAffiliationDto,
  CreatePersonRelationDto,
  UpdateAffiliationDto,
} from './dto/contact-relation.dto';
import { SubResourceQueryDto } from './dto/sub-resource-query.dto';
import { ListViewsService } from '../list-views/list-views.service';
import { RequirePermission } from '../common/permissions';
import { SensitiveResource } from '../common/permissions';
import { UseAcl, LoadResource } from '../common/permissions';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { NotesService } from '../notes/notes.service';
import { CreateNoteDto } from '../notes/dto/create-note.dto';
import { TasksService } from '../tasks/tasks.service';
import { TicketsService } from '../tickets/tickets.service';

@ApiTags('Contacts')
@ApiBearerAuth()
@UseInterceptors(DataMaskingInterceptor)
@SensitiveResource('contacts')
@Controller({
  path: 'contacts',
  version: '1',
})
export class ContactsController {
  constructor(
    private readonly service: ContactsService,
    private readonly timelineService: ContactTimelineService,
    private readonly relationsService: ContactRelationsService,
    private readonly identitySync: ContactIdentitySyncService,
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

  @Get('export-jobs')
  @RequirePermission('export', 'contacts')
  listExportJobs(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    return this.service.listExportJobs({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      status,
    });
  }

  @Post('export-jobs/:jobId/cancel')
  @RequirePermission('export', 'contacts')
  cancelExport(@Param('jobId') jobId: string) {
    return this.service.cancelExport(jobId);
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

  // ──────────────────────────── RECYCLE BIN ────────────────────────────
  //
  // `DELETE /contacts/:id` is a soft delete, so these two routes are what make
  // it recoverable. Declared BEFORE the `:id` routes below — Nest matches in
  // declaration order, and `recycle-bin` would otherwise be captured as an id.

  @ApiOkResponse({ description: 'Soft-deleted contacts awaiting purge' })
  @Get('recycle-bin')
  @RequirePermission('view', 'contacts')
  listDeleted(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.service.listDeleted({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @ApiOkResponse({ type: Contact })
  @Post(':id/restore')
  // Restoring re-exposes a record, so it takes `delete` — the same capability
  // that removed it — rather than `edit`.
  @RequirePermission('delete', 'contacts')
  // Record-level ACL/ABAC as well: you may only bring back a record you could
  // have seen. The PIP's loader uses `findById` with no soft-delete predicate, so
  // it hydrates the archived document and the owner/org-unit conditions evaluate
  // against the record as it was — which is the right basis for the decision.
  @UseAcl('delete', 'contacts')
  @LoadResource('contacts')
  restore(@Param('id') id: string) {
    return this.service.restore(id);
  }

  // ──────────────────────────── MERGE ────────────────────────────

  /**
   * Preview a merge without writing anything: the surviving value for every
   * field, what would be discarded, and how many related records would move.
   * The merge dialog needs this — a confirm prompt cannot tell a user what a
   * merge is about to cost them.
   */
  @ApiOkResponse({ description: 'What a merge would do, computed not guessed' })
  @Post(':id/merge-preview')
  @RequirePermission('edit', 'contacts')
  @UseAcl('edit', 'contacts')
  @LoadResource('contacts')
  previewMerge(
    @Param('id') id: string,
    @Query('targetId') targetId: string,
    @Body() body?: MergeContactsDto,
  ) {
    return this.service.previewMerge(id, targetId, body);
  }

  /**
   * Requires `delete`, not `edit`: a merge soft-deletes the losing contact, so an
   * edit-only permission here is a deletion path that skips the delete check. The
   * unmerge route below already required `delete` for the same reason, which made the
   * pair inconsistent — one permission to destroy a record, a stricter one to bring it
   * back. Salesforce draws the line the same way.
   */
  @Post(':id/merge')
  @RequirePermission('delete', 'contacts')
  @UseAcl('delete', 'contacts')
  @LoadResource('contacts')
  mergeContacts(
    @Param('id') id: string,
    @Query('targetId') targetId: string,
    @Body() body?: MergeContactsDto,
  ) {
    return this.service.mergeContacts(id, targetId, body);
  }

  @ApiOkResponse({ description: 'Merge history for this contact' })
  @Get(':id/merge-history')
  @RequirePermission('view', 'contacts')
  @UseAcl('view', 'contacts')
  @LoadResource('contacts')
  getMergeHistory(@Param('id') id: string) {
    return this.service.getMergeHistory(id);
  }

  /**
   * Reverse a merge. Takes `delete` because it resurrects a record; the ledger
   * row identifies the merge, so no contact id is needed.
   */
  @Post('merges/:mergeId/unmerge')
  @RequirePermission('delete', 'contacts')
  unmergeContacts(@Param('mergeId') mergeId: string) {
    return this.service.unmergeContacts(mergeId);
  }

  /** Operator action for a merge saga that stopped after partial re-parenting. */
  @Post('merges/:mergeId/recover')
  @RequirePermission('delete', 'contacts')
  recoverFailedMerge(@Param('mergeId') mergeId: string) {
    return this.service.recoverFailedMerge(mergeId);
  }

  @Post(':id/unmask-fields')
  @RequirePermission('unmask', 'contacts')
  @UseAcl('unmask', 'contacts')
  @LoadResource('contacts')
  unmaskFields(@Param('id') id: string, @Body() body: { fields?: string[] }) {
    return this.service.unmaskFields(id, body?.fields);
  }

  /**
   * The unified customer history: notes, tickets, deals, tasks, conversations,
   * activities and lifecycle transitions in one chronological feed.
   *
   * Replaces seven parallel requests (one per detail-page tab) with one, and
   * gives the contact page the screen every benchmarked CRM leads with. The
   * per-tab endpoints below are kept — they still back the individual tabs and
   * their own pagination.
   */
  @ApiOkResponse({ description: 'Unified chronological contact history' })
  @Get(':id/timeline')
  @RequirePermission('view', 'contacts')
  @UseAcl('view', 'contacts')
  @LoadResource('contacts')
  getTimeline(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('sources') sources?: string,
    @Query('before') before?: string,
  ) {
    return this.timelineService.getTimeline(id, {
      limit: limit ? parseInt(limit, 10) : undefined,
      sources: sources
        ? (sources.split(',').map((s) => s.trim()) as TimelineSource[])
        : undefined,
      before:
        before && !Number.isNaN(new Date(before).getTime())
          ? new Date(before)
          : undefined,
    });
  }

  // ──────────────────────── IDENTITIES ────────────────────────
  //
  // The reachable identities of a contact — emails, phones and channel accounts — as
  // rows rather than as the bare string arrays. `contact.emails[]` / `phones[]` remain
  // authoritative for reads across the product; these routes expose what the arrays
  // structurally cannot hold: which one is primary, whether it is verified or has
  // bounced, and per-identity consent.

  @ApiOkResponse({
    description:
      'Reachable identities with their primary/verified/bounced and consent state',
  })
  @Get(':id/identities')
  @RequirePermission('view', 'contacts')
  @UseAcl('view', 'contacts')
  @LoadResource('contacts')
  listIdentities(@Param('id') id: string) {
    return this.identitySync.listForContact(id);
  }

  /**
   * Consent for one identity.
   *
   * Takes `edit` rather than a narrower capability because recording consent is a
   * substantive change to what the business may do with the record — not a display
   * preference.
   */
  @Patch(':id/identities/:identityId/consent')
  @RequirePermission('edit', 'contacts')
  @UseAcl('edit', 'contacts')
  @LoadResource('contacts')
  setIdentityConsent(
    @Param('id') id: string,
    @Param('identityId') identityId: string,
    @Body() body: SetIdentityConsentDto,
  ) {
    return this.identitySync.setConsent(identityId, body.optIn ?? null);
  }

  @Patch(':id/identities/:identityId/deliverability')
  @RequirePermission('edit', 'contacts')
  @UseAcl('edit', 'contacts')
  @LoadResource('contacts')
  setIdentityDeliverability(
    @Param('id') id: string,
    @Param('identityId') identityId: string,
    @Body() body: SetIdentityDeliverabilityDto,
  ) {
    return this.identitySync.setDeliverability(identityId, body);
  }

  // ──────────────────────── RELATIONSHIPS ────────────────────────
  //
  // Person↔person relations and person↔company affiliations. Neither existed
  // before: the schema had a single `accountId` plus a free-text `companyName`,
  // so a person could not be a contact at two companies, could not have a role
  // that differed per company, and had no reports-to / referred-by / household
  // links at all — the largest purely functional gap against every benchmarked CRM.

  @ApiOkResponse({ description: 'People related to this contact' })
  @Get(':id/relations')
  @RequirePermission('view', 'contacts')
  @UseAcl('view', 'contacts')
  @LoadResource('contacts')
  listRelations(@Param('id') id: string) {
    return this.relationsService.listPersonRelations(id);
  }

  @Post(':id/relations')
  @RequirePermission('edit', 'contacts')
  @UseAcl('edit', 'contacts')
  @LoadResource('contacts')
  addRelation(@Param('id') id: string, @Body() body: CreatePersonRelationDto) {
    return this.relationsService.addPersonRelation(id, body);
  }

  @Delete(':id/relations/:relationId')
  @RequirePermission('edit', 'contacts')
  @UseAcl('edit', 'contacts')
  @LoadResource('contacts')
  removeRelation(
    @Param('id') id: string,
    @Param('relationId') relationId: string,
  ) {
    return this.relationsService.removePersonRelation(relationId);
  }

  @ApiOkResponse({ description: 'Companies this contact is affiliated with' })
  @Get(':id/affiliations')
  @RequirePermission('view', 'contacts')
  @UseAcl('view', 'contacts')
  @LoadResource('contacts')
  listAffiliations(@Param('id') id: string) {
    return this.relationsService.listAffiliations(id);
  }

  @Post(':id/affiliations')
  @RequirePermission('edit', 'contacts')
  @UseAcl('edit', 'contacts')
  @LoadResource('contacts')
  addAffiliation(@Param('id') id: string, @Body() body: CreateAffiliationDto) {
    return this.relationsService.addAffiliation(id, body);
  }

  @Patch(':id/affiliations/:affiliationId')
  @RequirePermission('edit', 'contacts')
  @UseAcl('edit', 'contacts')
  @LoadResource('contacts')
  updateAffiliation(
    @Param('id') id: string,
    @Param('affiliationId') affiliationId: string,
    @Body() body: UpdateAffiliationDto,
  ) {
    return this.relationsService.updateAffiliation(affiliationId, body);
  }

  @Delete(':id/affiliations/:affiliationId')
  @RequirePermission('edit', 'contacts')
  @UseAcl('edit', 'contacts')
  @LoadResource('contacts')
  removeAffiliation(
    @Param('id') id: string,
    @Param('affiliationId') affiliationId: string,
  ) {
    return this.relationsService.removeAffiliation(affiliationId);
  }

  @Get(':id/activities')
  @RequirePermission('view', 'contacts')
  @UseAcl('view', 'contacts')
  @LoadResource('contacts')
  async getActivities(
    @Param('id') id: string,
    @Query() query: SubResourceQueryDto,
  ) {
    await this.assertVisibleContact(id);
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
  @UseAcl('view', 'contacts')
  @LoadResource('contacts')
  async getNotes(@Param('id') id: string, @Query() query: SubResourceQueryDto) {
    await this.assertVisibleContact(id);
    return this.notesService.findByContact(id, query);
  }

  @Post(':id/notes')
  @RequirePermission('edit', 'contacts')
  @UseAcl('edit', 'contacts')
  @LoadResource('contacts')
  createNote(@Param('id') id: string, @Body() body: CreateNoteDto) {
    return this.notesService.createForContact(id, body);
  }

  @Delete(':id/notes/:noteId')
  @RequirePermission('delete', 'contacts')
  @UseAcl('delete', 'contacts')
  @LoadResource('contacts')
  async deleteContactNote(
    @Param('id') id: string,
    @Param('noteId') noteId: string,
  ) {
    await this.assertVisibleContact(id);
    return this.notesService.delete(noteId, id);
  }

  @Get(':id/tasks')
  @RequirePermission('view', 'tasks')
  @UseAcl('view', 'contacts')
  @LoadResource('contacts')
  async getTasks(@Param('id') id: string, @Query() query: SubResourceQueryDto) {
    await this.assertVisibleContact(id);
    return this.tasksService.findAll({ ...query, contactId: id });
  }

  @Get(':id/tickets')
  @RequirePermission('view', 'tickets')
  @UseAcl('view', 'contacts')
  @LoadResource('contacts')
  async getTickets(
    @Param('id') id: string,
    @Query() query: SubResourceQueryDto,
  ) {
    await this.assertVisibleContact(id);
    return this.ticketsService.findAll({ ...query, contactId: id });
  }

  @ApiOkResponse({ type: Contact })
  @Get(':id')
  @RequirePermission('view', 'contacts')
  @UseAcl('view', 'contacts')
  @LoadResource('contacts')
  @MaskedResource('Contact') // Fallback to Contact if specific resource not identified
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @ApiOkResponse({ type: Contact })
  @Patch(':id')
  @RequirePermission('edit', 'contacts')
  @UseAcl('edit', 'contacts')
  @LoadResource('contacts')
  @UsePipes(new SanitizeMaskedInputPipe())
  @MaskedResource('Contact')
  update(@Param('id') id: string, @Body() data: UpdateContactDto) {
    return this.service.update(id, data);
  }

  @Delete(':id')
  @RequirePermission('delete', 'contacts')
  @UseAcl('delete', 'contacts')
  @LoadResource('contacts')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Post(':id/change-stage')
  @RequirePermission('edit', 'contacts')
  @UseAcl('edit', 'contacts')
  @LoadResource('contacts')
  changeStage(@Param('id') id: string, @Body() body: ChangeStageDto) {
    return this.service.changeStage(id, body.stage, body);
  }

  @ApiOkResponse({ description: 'Stage transition history for a contact' })
  @Get(':id/stage-history')
  @RequirePermission('view', 'contacts')
  @UseAcl('view', 'contacts')
  @LoadResource('contacts')
  async getStageHistory(@Param('id') id: string) {
    await this.assertVisibleContact(id);
    return this.service.getStageHistory(id);
  }

  /**
   * Link a new omni-channel identity to an existing contact.
   * Body: { channelType: string, senderId: string }
   */
  @Post(':id/merge-identity')
  @RequirePermission('edit', 'contacts')
  @UseAcl('edit', 'contacts')
  @LoadResource('contacts')
  @ApiOkResponse({ type: Contact })
  mergeIdentity(
    @Param('id') id: string,
    @Body() body: { channelType: string; senderId: string },
  ) {
    return this.service.mergeIdentity(id, body);
  }

  private async assertVisibleContact(id: string): Promise<void> {
    if (!(await this.service.findOne(id))) {
      throw new NotFoundException(`Contact ${id} not found`);
    }
  }
}
