import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
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
import { ActivityLogService } from '../activity-log/activity-log.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ContactExportStorageService } from './contact-export-storage.service';
import { ContactSettingsService } from '../contact-settings/contact-settings.service';

@Injectable()
export class ContactsService {
  constructor(
    private readonly repository: ContactRepository,
    private readonly accountsService: AccountsService,
    private readonly dealsService: DealsService,
    private readonly settingsService: CrmSettingsService,
    private readonly cls: ClsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly activityLogService: ActivityLogService,
    private readonly auditLogService: AuditLogService,
    private readonly exportStorageService: ContactExportStorageService,
    private readonly contactSettingsService: ContactSettingsService,
  ) {}

  async create(data: CreateContactDto): Promise<Contact> {
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const emails = data.emails ?? [];
    const phones = data.phones ?? [];

    // tenant, createdBy, updatedBy are auto-injected by BaseDocumentRepository from CLS
    const contact = await this.repository.create({
      ...data,
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

    if (resolvePaginationMode(filter) === 'cursor') {
      return this.repository.findManyWithCursorPagination({
        filterOptions: filter,
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
      filterOptions: filter,
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
    // Sanitize ownerId: empty string is not a valid ObjectId
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const emails = data.emails;
    const phones = data.phones;

    // Shadow contact promotion: when a shadow contact gets real data, promote it
    const existingContact = await this.repository.findOne({ _id: id });
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
      ...additionalData,
      ...(emails !== undefined ? { emails } : {}),
      ...(phones !== undefined ? { phones } : {}),
      ownerId,
    } as any);

    // Emit automation event: field_updated.Contact
    if (updated) {
      const changedFields = Object.keys(data).filter((k) => k !== 'updatedBy');
      this.emitAutomationEvent('field_updated', updated, changedFields);

      if (
        ownerId !== undefined &&
        String(existingContact?.ownerId ?? '') !== String(ownerId ?? '')
      ) {
        await this.auditLogService.record({
          action: 'CONTACT_OWNER_CHANGED',
          targetEntityType: 'Contact',
          targetEntityId: id,
          metadata: {
            previousOwnerId: existingContact?.ownerId,
            nextOwnerId: ownerId,
          },
        });
      }
    }

    return updated;
  }

  async remove(id: string): Promise<void> {
    await this.repository.remove(id);
    await this.auditLogService.record({
      action: 'CONTACT_DELETED',
      targetEntityType: 'Contact',
      targetEntityId: id,
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
      await this.settingsService.getSetting('lifecycle:Contact');
    if (!lifecycle?.stages || !Array.isArray(lifecycle.stages)) {
      // Fallback: default stage pipeline if no settings configured
      return [
        'subscriber',
        'lead',
        'mql',
        'sql',
        'opportunity',
        'customer',
        'evangelist',
      ];
    }
    return lifecycle.stages
      .sort((a: any, b: any) => a.sortOrder - b.sortOrder)
      .map((s: any) => s.apiName);
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

    // Find the stage document by id or apiName
    const stages = await this.contactSettingsService.findAllLifecycleStages();
    const stageDoc = stages.find((s) => s.id === newStage || s.apiName === newStage);
    if (!stageDoc) {
      throw new BadRequestException(`Lifecycle stage "${newStage}" not found`);
    }

    // --- Guardrail 1: Validate stage exists in lifecycle config ---
    const validStages = await this.getValidStages();
    if (!validStages.includes(stageDoc.apiName)) {
      throw new BadRequestException(
        `Invalid lifecycle stage: "${stageDoc.apiName}". Valid stages: ${validStages.join(', ')}`,
      );
    }

    const previousStageDoc = stages.find(
      (s) => s.id === contact.lifecycleStageId || s.apiName === contact.lifecycleStageId,
    );
    const previousStageName = previousStageDoc ? previousStageDoc.apiName : null;

    // --- Guardrail 2: Compute transition direction + skipped stages ---
    const fromIndex = previousStageName ? validStages.indexOf(previousStageName) : -1;
    const toIndex = validStages.indexOf(stageDoc.apiName);

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

    // 1. Push stage history entry (atomic $push, no race conditions)
    await this.repository.pushStageHistory(id, {
      fromStage: previousStageName,
      toStage: stageDoc.apiName,
      changedAt: new Date(),
      changedById,
      reason: params?.reason,
      direction,
      skippedStages: skippedStages.length > 0 ? skippedStages : undefined,
    });

    const occurredAt = new Date();
    await this.activityLogService.create({
      targetType: 'contact',
      targetId: id,
      event: 'stage_change',
      actorId: changedById,
      occurredAt,
      payload: {
        fromStage: previousStageName,
        toStage: stageDoc.apiName,
        reason: params?.reason,
        direction,
        skippedStages: skippedStages.length > 0 ? skippedStages : undefined,
      },
    });
    await this.auditLogService.record({
      action: 'CONTACT_STAGE_CHANGED',
      targetEntityType: 'Contact',
      targetEntityId: id,
      actorId: changedById,
      metadata: {
        fromStage: previousStageName,
        toStage: stageDoc.apiName,
        direction,
        skippedStages,
        reason: params?.reason,
      },
    });
    await this.repository.touchLastActivity(id, occurredAt);

    let finalAccountId = params?.accountId;

    // 2. Optionally create account on stage transition
    if (params?.createAccount && params?.accountData) {
      const account = await this.accountsService.create(params.accountData);
      finalAccountId = account.id;
    }

    // 3. Update stage (and optionally link to account)
    const updated = await this.repository.update(id, {
      lifecycleStageId: stageDoc.id,
      ...(finalAccountId ? { accountId: finalAccountId } : {}),
    } as any);

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
      stage: stageDoc.apiName,
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
    token: string;
    expiresAt: string;
    ttlSeconds: number;
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
    const ttlSeconds = 30;

    await this.auditLogService.record({
      action: 'CONTACT_FIELDS_UNMASKED',
      targetEntityType: 'Contact',
      targetEntityId: id,
      metadata: {
        fields: fieldsToReturn,
        ttlSeconds,
      },
    });

    return {
      fields: rawFields,
      token: `${id}:${Date.now()}`,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      ttlSeconds,
    };
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
    if (tags.length === 0) {
      throw new BadRequestException('tags is required');
    }

    const result = await this.repository.addTagsToContacts(contactIds, tags);
    await this.auditLogService.record({
      action: 'CONTACTS_BULK_TAGGED',
      targetEntityType: 'Contact',
      targetEntityId: 'bulk',
      metadata: {
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

  async exportContacts(params: { ids?: string[]; filters?: any }): Promise<{
    downloadUrl: string;
    expiresAt: string;
    recordCount: number;
    storageKey: string;
  }> {
    const contacts =
      params.ids && params.ids.length > 0
        ? await this.repository.find({ _id: { $in: params.ids } } as any)
        : (
            await this.findAll({
              ...(params.filters || {}),
              paginationMode: 'offset',
              page: 1,
              limit: 5_000,
            })
          ).data;

    const header = [
      'id',
      'firstName',
      'lastName',
      'emails',
      'phones',
      'companyName',
      'title',
      'lifecycleStageId',
      'statusId',
      'lastActivityAt',
    ];
    const rows = contacts.map((contact: Contact) =>
      header.map((key) => this.csvCell((contact as any)[key])).join(','),
    );
    const csv = [header.join(','), ...rows].join('\n');
    const exportFile = await this.exportStorageService.storeCsv(
      csv,
      `contacts-export-${new Date().toISOString().slice(0, 10)}.csv`,
      5 * 60,
    );

    await this.activityLogService.create({
      targetType: 'contact',
      targetId: 'export',
      event: 'export',
      payload: {
        recordCount: contacts.length,
        ids: params.ids,
        filters: params.filters,
      },
    });
    await this.auditLogService.record({
      action: 'CONTACTS_EXPORTED',
      targetEntityType: 'Contact',
      targetEntityId: 'export',
      metadata: {
        recordCount: contacts.length,
        ids: params.ids,
        filters: params.filters,
        storageKey: exportFile.storageKey,
        expiresAt: exportFile.expiresAt,
      },
    });

    return {
      downloadUrl: exportFile.downloadUrl,
      expiresAt: exportFile.expiresAt,
      recordCount: contacts.length,
      storageKey: exportFile.storageKey,
    };
  }

  async getExportDownload(
    token: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    await this.auditLogService.record({
      action: 'CONTACT_EXPORT_DOWNLOADED',
      targetEntityType: 'Contact',
      targetEntityId: 'export',
      metadata: { token },
    });
    return this.exportStorageService.readLocalExport(token);
  }

  private csvCell(value: any): string {
    const normalized = Array.isArray(value)
      ? value.join('; ')
      : value instanceof Date
        ? value.toISOString()
        : value == null
          ? ''
          : String(value);
    return `"${normalized.replace(/"/g, '""')}"`;
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

    await this.activityLogService.create({
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
    await this.auditLogService.record({
      action: 'CONTACTS_MERGED',
      targetEntityType: 'Contact',
      targetEntityId: primaryId,
      metadata: {
        mergedContactId: targetId,
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
}
