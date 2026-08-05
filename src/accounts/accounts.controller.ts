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
import { AccountsService } from './accounts.service';
import { AccountMergeService } from './merge/account-merge.service';
import { ACCOUNT_ACTIVITY_TARGET_TYPE } from './merge/account-references.registry';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { Account } from './domain/account';
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
import { StartAccountImportDto } from './dto/start-account-import.dto';
import { ExportRequestDto } from '../common/export';
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

@ApiTags('Accounts')
@ApiBearerAuth()
@UseInterceptors(FieldPolicyInterceptor)
@ObjectFieldPolicy('Account')
@Controller({
  path: 'accounts',
  version: '1',
})
export class AccountsController {
  constructor(
    private readonly service: AccountsService,
    private readonly mergeService: AccountMergeService,
    private readonly activityLog: ActivityLogService,
  ) {}

  @Post()
  @RequirePermission('create', 'accounts')
  create(@Body() data: Partial<Account>) {
    return this.service.create(data);
  }

  /**
   * Warn that an account may already exist, before someone creates a second one.
   *
   * Advisory: it returns each candidate with a confidence, because a shared tax id is
   * conclusive while a matching name after suffix-stripping often is not. Blocking on a
   * name match would refuse legitimately distinct legal entities.
   *
   * Declared before the bare `@Get()` for readability only — Nest matches the literal
   * path regardless of order. The JSDoc sits ABOVE the decorators deliberately: written
   * between `@Get()` and the handler it separated the list route's decorators from
   * `findAll`, which silently handed them to this method instead. `GET /v1/accounts`
   * then answered `{ isDuplicate: false, duplicates: [] }` — a 200 with an empty
   * duplicate report where the account list belonged — and `findAll` stopped being a
   * route at all.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('check-duplicate')
  @RequirePermission('view', 'accounts')
  checkDuplicate(
    @Query('name') name?: string,
    @Query('website') website?: string,
    @Query('taxId') taxId?: string,
    @Query('excludeId') excludeId?: string,
  ) {
    return this.service.checkDuplicate({ name, website, taxId, excludeId });
  }

  @Get()
  @RequirePermission('view', 'accounts')
  findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  @Patch(':id')
  @RequirePermission('edit', 'accounts')
  @UseAcl('edit', 'accounts')
  @LoadResource('accounts')
  @UsePipes(new SanitizeMaskedInputPipe())
  update(@Param('id') id: string, @Body() data: Partial<Account>) {
    return this.service.update(id, data);
  }

  @Delete(':id')
  @RequirePermission('delete', 'accounts')
  @UseAcl('delete', 'accounts')
  @LoadResource('accounts')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  // RECYCLE BIN
  //
  // Declared BEFORE the `:id` routes — Nest matches in declaration order, and
  // `recycle-bin` would otherwise be captured as an id.

  @ApiOkResponse({ description: 'Soft-deleted accounts awaiting purge' })
  @Get('recycle-bin')
  @RequirePermission('view', 'accounts')
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
  @RequirePermission('delete', 'accounts')
  @UseAcl('delete', 'accounts')
  @LoadResource('accounts')
  restore(@Param('id') id: string) {
    return this.service.restore(id);
  }

  // MERGE

  /**
   * What a merge would do: the surviving value for every field, what would be
   * discarded, and how many contacts, deals and tickets would move. Writes nothing.
   *
   * A confirm prompt cannot tell someone what a merge is about to cost them, and for
   * accounts the cost is larger than for contacts — a wrong survivor drags a whole
   * book of business onto the wrong record.
   */
  @Post(':id/merge-preview')
  @RequirePermission('edit', 'accounts')
  @UseAcl('edit', 'accounts')
  @LoadResource('accounts')
  previewMerge(@Param('id') id: string, @Query('targetId') targetId: string) {
    return this.mergeService.preview(id, targetId);
  }

  /**
   * Merge `targetId` into `:id`.
   *
   * Requires `delete`, not `edit`. A merge soft-deletes the losing account, so an
   * edit-only permission would be a deletion path that bypasses the delete check —
   * and this is the shape of it that matters: an account is the parent of deals and
   * tickets, so merging one away moves revenue records. Salesforce draws the line in
   * the same place, requiring Delete on the object to merge it.
   */
  @Post(':id/merge')
  @RequirePermission('delete', 'accounts')
  @UseAcl('delete', 'accounts')
  @LoadResource('accounts')
  mergeAccounts(@Param('id') id: string, @Query('targetId') targetId: string) {
    return this.mergeService.merge(id, targetId);
  }

  /**
   * The account's activity feed.
   *
   * Added with merge, not before it, because merge is the first thing that writes an
   * account activity row — and a write with no reader is not a feature. The merge
   * service emitted `activity.create` with `targetType: 'account'` while no endpoint
   * served that feed, so "this account absorbed Acme Ltd" was recorded where nobody
   * could see it. `ACCOUNT_ACTIVITY_TARGET_TYPE` is shared with the writer and the
   * merge registry so all three agree on the string.
   */
  @Get(':id/activities')
  @RequirePermission('view', 'accounts')
  @UseAcl('view', 'accounts')
  @LoadResource('accounts')
  async getActivities(
    @Param('id') id: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    // 404 before reading the feed: without this, an id from another tenant returns an
    // empty list, which reads as "no activity" rather than "not yours".
    if (!(await this.service.findOne(id))) {
      throw new NotFoundException(`Account ${id} not found`);
    }
    return this.activityLog.getFeed({
      targetType: ACCOUNT_ACTIVITY_TARGET_TYPE,
      targetId: id,
      type: type as any,
      limit: limit ? Number(limit) : 20,
      cursor,
    });
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('bulk-tag')
  @RequirePermission('edit', 'accounts')
  bulkTag(@Body() body: { accountIds: string[]; tags: string[] }) {
    return this.service.bulkTagAccounts(body);
  }

  @Post('import-upload')
  @RequirePermission('create', 'accounts')
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
  @RequirePermission('create', 'accounts')
  startImport(@Body() dto: StartAccountImportDto) {
    return this.service.startImport(dto);
  }

  @Get('import-status/:jobId')
  @RequirePermission('view', 'accounts')
  getImportStatus(@Param('jobId') jobId: string) {
    return this.service.getImportStatus(jobId);
  }

  @Get('import-jobs')
  @RequirePermission('view', 'accounts')
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
  @RequirePermission('view', 'accounts')
  getImportJobDetail(@Param('id') id: string) {
    return this.service.getImportJobDetail(id);
  }

  @Get('import-report/:token')
  @RequirePermission('view', 'accounts')
  async getImportReport(@Param('token') token: string, @Res() res: Response) {
    const { buffer, filename } = await this.service.getImportReport(token);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(buffer);
  }

  @Post('export')
  @RequirePermission('export', 'accounts')
  exportAccounts(@Body() body: ExportRequestDto) {
    return this.service.exportAccounts(body || {});
  }

  @Get('export-status/:jobId')
  @RequirePermission('export', 'accounts')
  getExportStatus(@Param('jobId') jobId: string) {
    return this.service.getExportStatus(jobId);
  }

  @Get('export-jobs')
  @RequirePermission('export', 'accounts')
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
  @RequirePermission('export', 'accounts')
  cancelExport(@Param('jobId') jobId: string) {
    return this.service.cancelExport(jobId);
  }

  @Get('export-download/:token')
  @RequirePermission('export', 'accounts')
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
  @RequirePermission('view', 'accounts')
  @UseAcl('view', 'accounts')
  @LoadResource('accounts')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }
}
