import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Model } from 'mongoose';
import { ContactRepository } from './infrastructure/persistence/document/repositories/contact.repository';
import { Contact } from './domain/contact';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { AccountsService } from '../accounts/accounts.service';
import { DealsService } from '../deals/deals.service';
import { CrmSettingsService } from '../crm-settings/crm-settings.service';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AutomationEventPayload,
  buildAutomationEventName,
} from '../automation-rules/events/automation-event.payload';
import {
  DEFAULT_CURSOR_COUNT_LIMIT,
  clampPaginationLimit,
  resolvePaginationMode,
} from '../utils/cursor-pagination';
import { ContactExportStorageService } from './contact-export-storage.service';
import {
  CONTACT_EXPORT_QUEUE,
  CONTACT_IMPORT_QUEUE,
  DEFAULT_LIFECYCLE_STAGES,
  IMPORT_MAX_FILE_BYTES,
  MAX_BULK_TAG_SIZE,
  UNMASK_TTL_SECONDS,
} from './contacts.constants';
import { RedisLockService } from '../redis/redis-lock.service';
import { EntityAuditService } from '../common/audit/entity-audit.service';
import { StartImportDto } from './dto/start-import.dto';
import { createParser, detectFormat } from './import/import-parser.factory';
import { ImportTenantSettings } from './contact-import.processor';
import { Readable } from 'stream';
import {
  ImportJobSchemaClass,
  ImportJobDocument,
} from './infrastructure/persistence/document/entities/import-job.schema';

@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);

  constructor(
    private readonly repository: ContactRepository,
    private readonly accountsService: AccountsService,
    private readonly dealsService: DealsService,
    private readonly settingsService: CrmSettingsService,
    private readonly cls: ClsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly exportStorageService: ContactExportStorageService,
    private readonly lockService: RedisLockService,
    private readonly entityAudit: EntityAuditService,
    @InjectQueue(CONTACT_EXPORT_QUEUE)
    private readonly exportQueue: Queue,
    @InjectQueue(CONTACT_IMPORT_QUEUE)
    private readonly importQueue: Queue,
    @InjectModel(ImportJobSchemaClass.name)
    private readonly importJobModel: Model<ImportJobDocument>,
  ) {}

  async create(data: CreateContactDto): Promise<Contact> {
    const normalizedLifecycle = await this.normalizeLifecycleFields(data);
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const emails = data.emails ?? [];
    const phones = data.phones ?? [];

    // tenant, createdBy, updatedBy are auto-injected by BaseDocumentRepository from CLS
    const contact = await this.repository.create({
      ...data,
      ...normalizedLifecycle,
      emails,
      phones,
      ownerId,
    } as any);

    // Emit automation event: record_created.Contact
    this.emitAutomationEvent('record_created', contact);

    return contact;
  }

  async findAll(filter: any): Promise<any> {
    const limit = clampPaginationLimit(filter.limit);
    const tenantConfig =
      await this.settingsService.getSetting('data_access_policy');
    const restrictToOwner = tenantConfig?.restrict_own_contacts ?? false;
    const filterOptions = {
      ...filter,
      __restrictToOwner: restrictToOwner,
      __currentUserId: this.getCurrentUserId(),
    };

    if (resolvePaginationMode(filter) === 'cursor') {
      return this.repository.findManyWithCursorPagination({
        filterOptions,
        paginationOptions: {
          limit,
          cursor: filter.cursor,
          direction: filter.direction,
          sortBy: filter.sortBy,
          sortOrder: filter.sortOrder,
          countLimit: DEFAULT_CURSOR_COUNT_LIMIT,
        },
      });
    }

    return this.repository.findManyWithPagination({
      filterOptions,
      paginationOptions: {
        page: Number(filter.page) || 1,
        limit,
      },
    });
  }

  async findOne(id: string): Promise<Contact | null> {
    return this.repository.findOne({ _id: id });
  }

  async update(id: string, data: UpdateContactDto): Promise<Contact | null> {
    const existingContact = await this.repository.findOne({ _id: id });
    const normalizedLifecycle = await this.normalizeLifecycleFields(
      data,
      existingContact ?? undefined,
    );
    // Sanitize ownerId: empty string is not a valid ObjectId
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const emails = data.emails;
    const phones = data.phones;

    // Shadow contact promotion: when a shadow contact gets real data, promote it
    let additionalData: any = {};
    if (existingContact && existingContact.isShadow) {
      const hasNewEmail = emails && emails.length > 0;
      const hasNewPhone = phones && phones.length > 0;
      if (hasNewEmail || hasNewPhone) {
        additionalData = { isShadow: false };
      }
    }

    // updatedBy is auto-injected by BaseDocumentRepository from CLS
    const updated = await this.repository.update(id, {
      ...data,
      ...normalizedLifecycle,
      ...additionalData,
      ...(emails !== undefined ? { emails } : {}),
      ...(phones !== undefined ? { phones } : {}),
      ownerId,
    } as any);

    // Emit automation event: field_updated.Contact
    if (updated) {
      const changedFields = Object.keys(data).filter((k) => k !== 'updatedBy');
      this.emitAutomationEvent('field_updated', updated, changedFields);

      // Emit audit trail event: field-level change tracking
      // AuditLogListener diffs old vs new snapshot → audit_logs
      this.entityAudit.emit({
        entity: 'contact',
        entityType: 'CONTACT',
        entityId: id,
        kind: 'updated',
        oldSnapshot: existingContact ?? {},
        newSnapshot: updated,
      });
    }

    return updated;
  }

  async remove(id: string): Promise<void> {
    const existing = await this.repository.findOne({ _id: id });
    await this.repository.remove(id);

    // Compliance: record deletion in audit_logs
    // Emit `contact.updated` (not `.deleted`) for AuditLogListener compat;
    // AuditDiffEngine treats `_deleted: true` newSnapshot as a soft-delete.
    this.entityAudit.emit({
      entity: 'contact',
      entityType: 'CONTACT',
      entityId: id,
      kind: 'updated',
      oldSnapshot: existing ?? {},
      newSnapshot: { _deleted: true } as any,
    });
  }

  /**
   * Merge a new omni-channel identity (e.g. Zalo account) into an existing Contact.
   * Agent workflow: find a contact by phone/email, then link a new channel account.
   */
  async mergeIdentity(
    contactId: string,
    identity: { channelType: string; senderId: string },
  ): Promise<Contact> {
    const contact = await this.repository.findOne({ _id: contactId });
    if (!contact) {
      throw new NotFoundException(`Contact ${contactId} not found`);
    }

    // Check if this identity is already linked to another contact
    const existing = await this.repository.findByOmniIdentity(
      identity.channelType,
      identity.senderId,
    );
    if (existing && existing.id !== contactId) {
      throw new BadRequestException(
        `Identity ${identity.channelType}:${identity.senderId} is already linked to contact ${existing.id}`,
      );
    }

    const updated = await this.repository.addOmniIdentity(contactId, identity);
    if (!updated) {
      throw new NotFoundException(
        `Contact ${contactId} not found after update`,
      );
    }
    return updated;
  }

  async checkDuplicate(params: {
    emails?: string;
    phones?: string;
    excludeId?: string;
  }): Promise<any> {
    const duplicates = await this.repository.checkDuplicate(params);
    return {
      isDuplicate: duplicates.length > 0,
      duplicates: duplicates.map((d) => ({
        id: d.id,
        name: `${d.firstName} ${d.lastName}`,
        email: d.emails?.[0],
        phone: d.phones?.[0],
        stage: d.lifecycleStageId,
      })),
    };
  }

  /**
   * Find a contact by email address in the emails[] array.
   * Used for email channel deduplication.
   */
  async findByEmail(tenantId: string, email: string): Promise<Contact | null> {
    return this.repository.findOne({
      tenantId,
      emails: email.toLowerCase(),
    });
  }

  /**
   * Find a contact by omniIdentities senderId.
   * Used for email channel deduplication when emails[] is empty.
   */
  async findBySenderId(
    tenantId: string,
    channelType: string,
    senderId: string,
  ): Promise<Contact | null> {
    return this.repository.findOne({
      tenantId,
      'omniIdentities.channelType': channelType,
      'omniIdentities.senderId': senderId,
    });
  }

  /**
   * Add an email to a contact's emails[] array if not already present.
   * Uses MongoDB $addToSet for atomicity.
   */
  async addEmailIfMissing(contactId: string, email: string): Promise<void> {
    await this.repository.addEmailIfMissing(contactId, email.toLowerCase());
  }

  /**
   * Resolve the valid lifecycle stages from tenant settings.
   * Returns an ordered array of stage apiNames.
   */
  private async getValidStages(): Promise<string[]> {
    const lifecycle =
      await this.settingsService.getSetting('contact_lifecycle');
    if (!lifecycle?.stages || !Array.isArray(lifecycle.stages)) {
      return [...DEFAULT_LIFECYCLE_STAGES];
    }
    return lifecycle.stages
      .sort((a: any, b: any) => a.sortOrder - b.sortOrder)
      .map((s: any) => s.apiName);
  }

  private async getContactLifecycle(): Promise<any> {
    return this.settingsService.getSetting('contact_lifecycle');
  }

  private sortBySortOrder<T extends { sortOrder?: number }>(
    items: T[] = [],
  ): T[] {
    return [...items].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }

  private findLifecycleStage(lifecycle: any, value?: string) {
    if (!value) return undefined;
    return lifecycle?.stages?.find(
      (stage: any) => stage.apiName === value || stage.id === value,
    );
  }

  private findLifecycleStatus(stage: any, value?: string) {
    if (!value) return undefined;
    return stage?.statuses?.find(
      (status: any) => status.apiName === value || status.id === value,
    );
  }

  private async normalizeLifecycleFields(
    data: Pick<CreateContactDto, 'lifecycleStageId' | 'statusId'>,
    existingContact?: Pick<Contact, 'lifecycleStageId' | 'statusId'>,
  ): Promise<Partial<Pick<Contact, 'lifecycleStageId' | 'statusId'>>> {
    const lifecycle = await this.getContactLifecycle();
    const stages = this.sortBySortOrder(lifecycle?.stages ?? []);
    const existingStage = this.findLifecycleStage(
      lifecycle,
      existingContact?.lifecycleStageId,
    );
    const requestedStage =
      this.findLifecycleStage(lifecycle, data.lifecycleStageId) ??
      existingStage ??
      stages[0];

    if (!requestedStage) return {};

    const normalized: Partial<Pick<Contact, 'lifecycleStageId' | 'statusId'>> =
      {};
    if (data.lifecycleStageId !== undefined || !existingStage) {
      normalized.lifecycleStageId = requestedStage.apiName;
    }

    const statuses = this.sortBySortOrder(requestedStage.statuses ?? []);
    const existingStatus = this.findLifecycleStatus(
      requestedStage,
      existingContact?.statusId,
    );
    const requestedStatus =
      this.findLifecycleStatus(requestedStage, data.statusId) ??
      existingStatus ??
      statuses.find((status: any) => status.isDefault) ??
      statuses[0];

    if (
      requestedStatus &&
      (data.statusId !== undefined ||
        data.lifecycleStageId !== undefined ||
        !existingStatus)
    ) {
      normalized.statusId = requestedStatus.apiName;
    }

    return normalized;
  }

  /**
   * Change the lifecycle stage of a contact.
   * This replaces the old convertLead method — "conversion" is now just a stage transition.
   * Records a stage history entry for conversion rate and velocity tracking.
   *
   * Guardrails (v2.5):
   * - Validates that newStage exists in lifecycle config (rejects invalid strings)
   * - Computes transition direction (forward/backward/lateral) for analytics
   * - Records skipped stages when jumping non-sequentially
   */
  async changeStage(
    id: string,
    newStage: string,
    params?: {
      createAccount?: boolean;
      accountId?: string;
      accountData?: any;
      dealData?: any;
      reason?: string;
    },
  ): Promise<any> {
    const contact = await this.repository.findOne({ _id: id });
    if (!contact) throw new NotFoundException('Contact not found');

    const lifecycle = await this.getContactLifecycle();
    const stage = this.findLifecycleStage(lifecycle, newStage);
    if (!stage) {
      throw new BadRequestException(`Lifecycle stage "${newStage}" not found`);
    }

    // --- Guardrail 1: Validate stage exists in lifecycle config ---
    const validStages = await this.getValidStages();
    if (!validStages.includes(stage.apiName)) {
      throw new BadRequestException(
        `Invalid lifecycle stage: "${stage.apiName}". Valid stages: ${validStages.join(', ')}`,
      );
    }

    const previousStage = this.findLifecycleStage(
      lifecycle,
      contact.lifecycleStageId,
    );
    const previousStageName = previousStage?.apiName ?? null;

    // --- Guardrail 2: Compute transition direction + skipped stages ---
    const fromIndex = previousStageName
      ? validStages.indexOf(previousStageName)
      : -1;
    const toIndex = validStages.indexOf(stage.apiName);

    let direction: 'forward' | 'backward' | 'lateral' = 'lateral';
    let skippedStages: string[] = [];

    if (fromIndex >= 0 && toIndex >= 0) {
      if (toIndex > fromIndex) {
        direction = 'forward';
        // Record any skipped stages (non-sequential forward jump)
        if (toIndex - fromIndex > 1) {
          skippedStages = validStages.slice(fromIndex + 1, toIndex);
        }
      } else if (toIndex < fromIndex) {
        direction = 'backward';
        // Record stages being "reversed over"
        if (fromIndex - toIndex > 1) {
          skippedStages = validStages.slice(toIndex + 1, fromIndex);
        }
      }
    }

    // Get the current user from CLS context for attribution
    const changedById = this.cls.get('user.id') || contact.updatedById;

    let finalAccountId = params?.accountId;

    // 1. Optionally create account on stage transition
    if (params?.createAccount && params?.accountData) {
      const account = await this.accountsService.create(params.accountData);
      finalAccountId = account.id;
    }

    // 2. Update stage (and optionally link to account) with optimistic locking
    const sortedStatuses = this.sortBySortOrder<any>(stage.statuses ?? []);
    const defaultStatus =
      sortedStatuses.find((status: any) => status.isDefault) ??
      sortedStatuses[0];
    const updated = await this.repository.updateWithVersionCheck(
      id,
      contact.version ?? 0,
      {
        lifecycleStageId: stage.apiName,
        ...(defaultStatus ? { statusId: defaultStatus.apiName } : {}),
        ...(finalAccountId ? { accountId: finalAccountId } : {}),
      } as any,
    );
    if (!updated) {
      throw new ConflictException(
        'Stage was updated concurrently by another user. Please reload and try again.',
      );
    }

    // 3. Record transition side effects after the versioned update succeeds.
    const occurredAt = new Date();
    await this.repository.pushStageHistory(id, {
      fromStage: previousStageName,
      toStage: stage.apiName,
      changedAt: occurredAt,
      changedById,
      reason: params?.reason,
      direction,
      skippedStages: skippedStages.length > 0 ? skippedStages : undefined,
    });
    // Stage change is NOT written to Activity Log.
    // Sales timeline uses Virtual Activity (pulled from stageHistory[]).
    // Audit Trail captures field-level diff (lifecycleStageId) automatically.

    // Emit audit trail: field-level diff (lifecycleStageId, statusId)
    // AuditLogListener will compute old vs new snapshot → audit_logs
    this.entityAudit.emit({
      entity: 'contact',
      entityType: 'CONTACT',
      entityId: id,
      kind: 'updated',
      oldSnapshot: contact,
      newSnapshot: updated,
    });

    await this.repository.touchLastActivity(id, occurredAt);

    // 4. Optionally create deal on stage transition
    let dealId: string | undefined;
    if (params?.dealData && updated) {
      const deal = await this.dealsService.create({
        ...params.dealData,
        contactId: updated.id,
        accountId: finalAccountId,
      });
      dealId = deal.id;
    }

    return {
      success: true,
      contact: id,
      previousStage: previousStageName,
      stage: stage.apiName,
      direction,
      skippedStages: skippedStages.length > 0 ? skippedStages : undefined,
      account: finalAccountId,
      deal: dealId,
    };
  }

  /**
   * Get the stage transition history for a contact.
   * Returns entries sorted newest-first.
   */
  async getStageHistory(id: string): Promise<any[]> {
    const contact = await this.repository.findOne({ _id: id });
    if (!contact) throw new NotFoundException('Contact not found');
    return this.repository.getStageHistory(id);
  }

  // ── Automation Event Emitter ─────────────────────────────────────────────

  async unmaskFields(
    id: string,
    requestedFields?: string[],
  ): Promise<{
    fields: Pick<Contact, 'emails' | 'phones'>;
  }> {
    const contact = await this.repository.findOne({ _id: id });
    if (!contact) throw new NotFoundException('Contact not found');

    const allowedFields = new Set(['emails', 'phones']);
    const fieldsToReturn =
      requestedFields && requestedFields.length > 0
        ? requestedFields.filter((field) => allowedFields.has(field))
        : ['emails', 'phones'];

    const rawFields: Pick<Contact, 'emails' | 'phones'> = {
      emails: fieldsToReturn.includes('emails') ? contact.emails || [] : [],
      phones: fieldsToReturn.includes('phones') ? contact.phones || [] : [],
    };
    const ttlSeconds = UNMASK_TTL_SECONDS;

    // fields_unmasked is a compliance/system action — not written to Activity Log.

    return { fields: rawFields };
  }

  async bulkTagContacts(params: {
    contactIds: string[];
    tags: string[];
  }): Promise<{ success: true; matchedCount: number; modifiedCount: number }> {
    const contactIds = Array.from(new Set(params.contactIds || [])).filter(
      Boolean,
    );
    const tags = Array.from(
      new Set(
        (params.tags || [])
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0),
      ),
    );

    if (contactIds.length === 0) {
      throw new BadRequestException('contactIds is required');
    }
    if (contactIds.length > MAX_BULK_TAG_SIZE) {
      throw new BadRequestException(
        `Bulk operation exceeds maximum of ${MAX_BULK_TAG_SIZE} contacts per request. Received: ${contactIds.length}`,
      );
    }
    if (tags.length === 0) {
      throw new BadRequestException('tags is required');
    }

    const result = await this.repository.addTagsToContacts(contactIds, tags);
    // bulk_tagged: field-level diff (tags) already captured by audit_logs.

    return {
      success: true,
      ...result,
    };
  }

  async exportContacts(params: {
    ids?: string[];
    filters?: any;
  }): Promise<{ jobId: string; status: 'queued' }> {
    const tenantConfig =
      await this.settingsService.getSetting('data_access_policy');
    const job = await this.exportQueue.add('export', {
      tenantId: this.cls.get('activeTenantId') || this.cls.get('tenantId'),
      userId: this.getCurrentUserId(),
      ids: params.ids,
      filters: {
        ...(params.filters || {}),
        __restrictToOwner: tenantConfig?.restrict_own_contacts ?? false,
        __currentUserId: this.getCurrentUserId(),
      },
    });

    return { jobId: String(job.id), status: 'queued' };
  }

  async getExportStatus(jobId: string): Promise<{
    status: string;
    progress: unknown;
    result: any;
    failedReason?: string;
  }> {
    const job = await this.exportQueue.getJob(jobId);
    if (!job) {
      throw new NotFoundException('Export job not found');
    }

    const tenantId = this.cls.get('activeTenantId') || this.cls.get('tenantId');
    const userId = this.getCurrentUserId();
    if (
      String(job.data?.tenantId ?? '') !== String(tenantId ?? '') ||
      (job.data?.userId && String(job.data.userId) !== String(userId ?? ''))
    ) {
      throw new NotFoundException('Export job not found');
    }

    return {
      status: await job.getState(),
      progress: job.progress,
      result: job.returnvalue,
      failedReason: job.failedReason,
    };
  }

  async getExportDownload(
    token: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    // export_downloaded: system action — not written to Activity Log.
    return this.exportStorageService.readLocalExport(token);
  }

  // ──────────────────────────── CONTACT IMPORT ────────────────────────────

  /**
   * Store an uploaded .csv/.xlsx and return its storage key plus the parsed
   * header row so the client can build the field-mapping UI.
   */
  async uploadImportFile(file: {
    buffer: Buffer;
    originalname: string;
    size: number;
  }): Promise<{ fileKey: string; format: string; headers: string[] }> {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    if (file.size > IMPORT_MAX_FILE_BYTES) {
      throw new BadRequestException(
        `File exceeds the ${IMPORT_MAX_FILE_BYTES / (1024 * 1024)}MB limit`,
      );
    }
    const format = detectFormat(file.originalname);

    // Parse just the header row before persisting so we fail fast on garbage.
    const parser = createParser(format);
    const headers = await parser.readHeaders(Readable.from(file.buffer));
    if (headers.length === 0) {
      throw new BadRequestException('File has no header row');
    }

    const { fileKey } = await this.exportStorageService.storeImportFile({
      buffer: file.buffer,
      originalname: file.originalname,
    });

    return { fileKey, format, headers };
  }

  async startImport(
    dto: StartImportDto,
  ): Promise<{ jobId: string; status: 'queued' }> {
    // 1. Required-field mapping: schema marks firstName + lastName required.
    const mappedFields = new Set(Object.values(dto.mapping ?? {}));
    if (!mappedFields.has('firstName') || !mappedFields.has('lastName')) {
      throw new BadRequestException(
        'mapping must include both firstName and lastName',
      );
    }

    // 2. Dedup matching fields must be index-backed (emails / phones only).
    if (dto.deduplication) {
      const allowed = new Set(['emails', 'phones']);
      const bad = dto.deduplication.matchingFields.filter(
        (f) => !allowed.has(f),
      );
      if (bad.length) {
        throw new BadRequestException(
          `Unsupported dedup matchingFields: ${bad.join(', ')}`,
        );
      }
      // A dedup field is meaningless unless some column maps onto it.
      const missing = dto.deduplication.matchingFields.filter(
        (f) => !mappedFields.has(f),
      );
      if (missing.length) {
        throw new BadRequestException(
          `Dedup field(s) [${missing.join(', ')}] are not present in the column mapping`,
        );
      }
    }

    // 3. The uploaded file must still exist in storage.
    const exists = await this.exportStorageService.importFileExists(
      dto.fileKey,
    );
    if (!exists) {
      throw new BadRequestException(
        'fileKey not found in storage — upload the file again',
      );
    }

    // 4. Snapshot tenant identity settings AT ENQUEUE TIME so the worker never
    //    queries crm_settings inside its hot loop (latency + consistency).
    const identity =
      (await this.settingsService.getSetting('contact_identity')) ?? {};
    const tenantSettings: ImportTenantSettings = {
      uniqueEmail: identity.uniqueEmail ?? true,
      uniquePhone: identity.uniquePhone ?? true,
      multipleEmailsAllowed: identity.multipleEmailsAllowed ?? false,
      multiplePhonesAllowed: identity.multiplePhonesAllowed ?? false,
    };

    const job = await this.importQueue.add('import', {
      tenantId: this.cls.get('activeTenantId') || this.cls.get('tenantId'),
      userId: this.getCurrentUserId(),
      fileKey: dto.fileKey,
      mapping: dto.mapping,
      deduplication: dto.deduplication,
      dryRun: dto.dryRun ?? false,
      triggerAutomations: dto.triggerAutomations ?? false,
      estimatedRows: dto.estimatedRows,
      tenantSettings,
    });

    // Persist to MongoDB for import history
    const tenantId = this.cls.get('activeTenantId') || this.cls.get('tenantId');
    const userId = this.getCurrentUserId();
    try {
      await this.importJobModel.create({
        tenantId,
        userId,
        fileName: dto.fileName || dto.fileKey.split('/').pop() || 'unknown',
        fileFormat: dto.fileFormat || (dto.fileKey.endsWith('.xlsx') ? 'xlsx' : 'csv'),
        rowCount: dto.estimatedRows ?? 0,
        status: 'queued',
        bullJobId: String(job.id),
        dryRun: dto.dryRun ?? false,
        mapping: dto.mapping,
        deduplication: dto.deduplication,
        triggerAutomations: dto.triggerAutomations ?? false,
        startedAt: new Date(),
      });
    } catch (err) {
      // Non-critical: don't fail the import if history record fails
      this.logger.warn(`Failed to persist import history record: ${(err as Error).message}`);
    }

    return { jobId: String(job.id), status: 'queued' };
  }

  // ─────────────────────── IMPORT HISTORY ───────────────────────────

  async listImportJobs(options: {
    page?: number;
    limit?: number;
    status?: string;
  }): Promise<{
    data: any[];
    total: number;
    page: number;
    limit: number;
  }> {
    const tenantId = this.cls.get('activeTenantId') || this.cls.get('tenantId');
    const userId = this.getCurrentUserId();
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(50, Math.max(1, options.limit ?? 10));
    const skip = (page - 1) * limit;

    const filter: Record<string, any> = { tenantId, userId };
    if (
      options.status &&
      ['queued', 'active', 'completed', 'failed'].includes(options.status)
    ) {
      filter.status = options.status;
    }

    const [data, total] = await Promise.all([
      this.importJobModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.importJobModel.countDocuments(filter).exec(),
    ]);

    // For active/queued jobs, enrich with real-time BullMQ progress
    for (const doc of data) {
      if (doc.status === 'active' || doc.status === 'queued') {
        try {
          const bullJob = await this.importQueue.getJob(doc.bullJobId);
          if (bullJob) {
            const state = await bullJob.getState();
            (doc as any).status = state;
            if (bullJob.progress && typeof bullJob.progress === 'object') {
              (doc as any).progress = bullJob.progress;
            }
          }
        } catch {
          // BullMQ job may have been cleaned up — keep MongoDB status
        }
      }
    }

    return { data, total, page, limit };
  }

  async getImportJobDetail(id: string) {
    const tenantId = this.cls.get('activeTenantId') || this.cls.get('tenantId');
    const userId = this.getCurrentUserId();

    const doc = await this.importJobModel
      .findOne({ _id: id, tenantId, userId })
      .lean()
      .exec();
    if (!doc) throw new NotFoundException('Import job not found');

    // Enrich active jobs with real-time progress from BullMQ
    if (doc.status === 'active' || doc.status === 'queued') {
      try {
        const bullJob = await this.importQueue.getJob(doc.bullJobId);
        if (bullJob) {
          (doc as any).status = await bullJob.getState();
          if (bullJob.progress && typeof bullJob.progress === 'object') {
            (doc as any).progress = bullJob.progress;
          }
        }
      } catch {
        // BullMQ job cleaned up
      }
    }

    return doc;
  }

  async getImportStatus(jobId: string): Promise<{
    status: string;
    progress: unknown;
    result: any;
    failedReason?: string;
  }> {
    const job = await this.importQueue.getJob(jobId);
    if (!job) {
      throw new NotFoundException('Import job not found');
    }

    // Same ownership guard as export: a job is only visible to the tenant +
    // user that created it.
    const tenantId = this.cls.get('activeTenantId') || this.cls.get('tenantId');
    const userId = this.getCurrentUserId();
    if (
      String(job.data?.tenantId ?? '') !== String(tenantId ?? '') ||
      (job.data?.userId && String(job.data.userId) !== String(userId ?? ''))
    ) {
      throw new NotFoundException('Import job not found');
    }

    return {
      status: await job.getState(),
      progress: job.progress,
      result: job.returnvalue,
      failedReason: job.failedReason,
    };
  }

  getImportReport(
    token: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    return this.exportStorageService.readLocalReport(token);
  }

  async mergeContacts(
    primaryId: string,
    targetId: string,
  ): Promise<{ success: true; contact: Contact; mergedContactId: string }> {
    if (primaryId === targetId) {
      throw new BadRequestException('Cannot merge a contact into itself');
    }

    // Sorted lock key prevents deadlocks — always same order regardless of caller
    const [a, b] = [primaryId, targetId].sort();
    const lockKey = `lock:contact:merge:${a}:${b}`;

    return this.lockService.acquire(lockKey, 10_000, async () => {
      return this.executeMerge(primaryId, targetId);
    });
  }

  private async executeMerge(
    primaryId: string,
    targetId: string,
  ): Promise<{ success: true; contact: Contact; mergedContactId: string }> {
    // Reads must happen INSIDE the merge lock so that a concurrent delete
    // of either contact between acquire and read is caught by the deletedAt
    // guard below. We use Promise.all so latency stays low — the lock
    // already serializes us against other merges of the same pair.
    const [primary, target] = await Promise.all([
      this.repository.findOne({ _id: primaryId }),
      this.repository.findOne({ _id: targetId }),
    ]);

    if (!primary || primary.deletedAt) {
      throw new NotFoundException('Primary contact not found');
    }
    if (!target || target.deletedAt) {
      throw new NotFoundException('Target contact not found');
    }

    const unionByValue = <T>(left: T[] = [], right: T[] = []) =>
      Array.from(new Set([...left, ...right].filter(Boolean)));
    const identityKey = (identity: { channelType: string; senderId: string }) =>
      `${identity.channelType}:${identity.senderId}`;
    const omniIdentities = [
      ...(primary.omniIdentities || []),
      ...(target.omniIdentities || []),
    ].filter((identity, index, all) => {
      const key = identityKey(identity);
      return all.findIndex((item) => identityKey(item) === key) === index;
    });

    const occurredAt = new Date();

    // Re-check both contacts immediately before mutation. A long-running
    // merge could be preempted (heartbeat lost, GC pause), and another
    // operation might have deleted the target in between. Without this
    // re-check we could silently overwrite primary with stale data drawn
    // from a target that is now gone.
    const [primaryNow, targetNow] = await Promise.all([
      this.repository.findOne({ _id: primaryId }),
      this.repository.findOne({ _id: targetId }),
    ]);
    if (!primaryNow || primaryNow.deletedAt) {
      throw new NotFoundException('Primary contact was deleted during merge');
    }
    if (!targetNow || targetNow.deletedAt) {
      throw new NotFoundException('Target contact was deleted during merge');
    }

    const merged = await this.repository.update(primaryId, {
      emails: unionByValue(primary.emails, target.emails),
      phones: unionByValue(primary.phones, target.phones),
      omniIdentities,
      stageHistory: [
        ...(primary.stageHistory || []),
        ...(target.stageHistory || []),
      ].sort(
        (a, b) =>
          new Date(a.changedAt).getTime() - new Date(b.changedAt).getTime(),
      ),
      lastActivityAt: occurredAt,
    } as any);

    await this.repository.update(targetId, {
      deletedAt: occurredAt,
      lastActivityAt: occurredAt,
    } as any);

    this.emitActivityLog({
      targetType: 'contact',
      targetId: primaryId,
      event: 'merge',
      occurredAt,
      payload: {
        mergedContactId: targetId,
        emailsAdded: target.emails || [],
        phonesAdded: target.phones || [],
      },
    });

    return {
      success: true,
      contact: merged!,
      mergedContactId: targetId,
    };
  }

  private emitAutomationEvent(
    event: 'record_created' | 'field_updated',
    record: Contact,
    changedFields?: string[],
  ): void {
    const tenantId = this.cls.get('activeTenantId') || this.cls.get('tenantId');
    if (!tenantId) return; // No tenant context (e.g. seeder, migration)

    const payload: AutomationEventPayload = {
      tenantId,
      event,
      object: 'Contact',
      recordId: record.id,
      data: record as any,
      ...(changedFields ? { changedFields } : {}),
      automationDepth: 0,
    };

    // Fire-and-forget — errors are caught by the listener
    this.eventEmitter.emit(buildAutomationEventName(event, 'Contact'), payload);
  }

  private emitActivityLog(input: {
    targetType: string;
    targetId: string;
    event: string;
    actorId?: string;
    payload?: Record<string, any>;
    occurredAt?: Date;
  }): void {
    this.eventEmitter.emit('activity.create', {
      ...input,
      tenantId: this.cls.get('activeTenantId') || this.cls.get('tenantId'),
      actorId: input.actorId || this.getCurrentUserId(),
    });
  }

  private getCurrentUserId(): string | undefined {
    return this.cls.get('userId') || this.cls.get('user.id');
  }
}
