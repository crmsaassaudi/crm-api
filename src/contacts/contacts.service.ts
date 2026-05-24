import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
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
  DEFAULT_LIFECYCLE_STAGES,
  MAX_BULK_TAG_SIZE,
  UNMASK_TTL_SECONDS,
} from './contacts.constants';

@Injectable()
export class ContactsService {
  constructor(
    private readonly repository: ContactRepository,
    private readonly accountsService: AccountsService,
    private readonly dealsService: DealsService,
    private readonly settingsService: CrmSettingsService,
    private readonly cls: ClsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly exportStorageService: ContactExportStorageService,
    @InjectQueue(CONTACT_EXPORT_QUEUE)
    private readonly exportQueue: Queue,
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
      this.eventEmitter.emit('contact.updated', {
        t: new Date(),
        tenantId:
          this.cls.get('activeTenantId') || this.cls.get('tenantId'),
        entityId: id,
        entityType: 'CONTACT',
        oldSnapshot: existingContact
          ? JSON.parse(JSON.stringify(existingContact))
          : {},
        newSnapshot: JSON.parse(JSON.stringify(updated)),
        actorId: this.getCurrentUserId(),
        src: this.cls.get('executionSource') || 'M',
        ctx: this.cls.get('sourceContext'),
        ip: this.cls.get('requestIp'),
        ua: this.cls.get('userAgent'),
      });
    }

    return updated;
  }

  async remove(id: string): Promise<void> {
    await this.repository.remove(id);
    this.emitActivityLog({
      targetType: 'contact',
      targetId: id,
      event: 'deleted',
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
        'Stage da duoc thay doi dong thoi boi nguoi dung khac. Vui long tai lai va thu lai.',
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
    this.emitActivityLog({
      targetType: 'contact',
      targetId: id,
      event: 'stage_change',
      actorId: changedById,
      occurredAt,
      payload: {
        fromStage: previousStageName,
        toStage: stage.apiName,
        reason: params?.reason,
        direction,
        skippedStages: skippedStages.length > 0 ? skippedStages : undefined,
      },
    });

    // Emit audit trail: field-level diff (lifecycleStageId, statusId)
    // AuditLogListener will compute old vs new snapshot → audit_logs
    this.eventEmitter.emit('contact.updated', {
      t: occurredAt,
      tenantId: this.cls.get('activeTenantId') || this.cls.get('tenantId'),
      entityId: id,
      entityType: 'CONTACT',
      oldSnapshot: JSON.parse(JSON.stringify(contact)),
      newSnapshot: JSON.parse(JSON.stringify(updated)),
      actorId: changedById,
      src: this.cls.get('executionSource') || 'M',
      ctx: this.cls.get('sourceContext'),
      ip: this.cls.get('requestIp'),
      ua: this.cls.get('userAgent'),
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

    this.emitActivityLog({
      targetType: 'contact',
      targetId: id,
      event: 'fields_unmasked',
      payload: {
        fields: fieldsToReturn,
        ttlSeconds,
      },
    });

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
    this.emitActivityLog({
      targetType: 'contact',
      targetId: 'bulk',
      event: 'bulk_tagged',
      payload: {
        contactIds,
        tags,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
      },
    });

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
    this.emitActivityLog({
      targetType: 'contact',
      targetId: 'export',
      event: 'export_downloaded',
      payload: { token },
    });
    return this.exportStorageService.readLocalExport(token);
  }

  async mergeContacts(
    primaryId: string,
    targetId: string,
  ): Promise<{ success: true; contact: Contact; mergedContactId: string }> {
    if (primaryId === targetId) {
      throw new BadRequestException('Cannot merge a contact into itself');
    }

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
