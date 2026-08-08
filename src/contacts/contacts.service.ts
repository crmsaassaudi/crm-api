import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import Redis from 'ioredis';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { ContactRepository } from './infrastructure/persistence/document/repositories/contact.repository';
import { Contact } from './domain/contact';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { AccountsService } from '../accounts/accounts.service';
import { DealsService } from '../deals/deals.service';
import { CrmSettingsService } from '../crm-settings/crm-settings.service';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AutomationEventPayload } from '../automation-rules/events/automation-event.payload';
import { AutomationOutboxService } from '../automation-rules/events/automation-outbox.service';
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
  IMPORT_CUSTOM_FIELD_PREFIX,
  IMPORT_MAPPABLE_FIELDS,
  IMPORT_MAX_FILE_BYTES,
  MAX_BULK_TAG_SIZE,
} from './contacts.constants';
import { RedisLockService } from '../redis/redis-lock.service';
import { EntityAuditService } from '../common/audit/entity-audit.service';
import { IOREDIS_CLIENT } from '../redis/redis.tokens';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ExportContactsDto } from './dto/export-contacts.dto';
import {
  ExportProgressTracker,
  ExportStorageFactory,
  ExportStorageService,
  ExportJobSchemaClass,
  ExportJobDocument,
} from '../common/export';
import { StartImportDto } from './dto/start-import.dto';
import { createParser, detectFormat } from './import/import-parser.factory';
import {
  ImportStorageFactory,
  ImportStorageService,
} from '../common/import/import-storage.service';
import {
  ImportCatalog,
  ImportTenantSettings,
} from './contact-import.processor';
import { createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import {
  ImportJobSchemaClass,
  ImportJobDocument,
} from './infrastructure/persistence/document/entities/import-job.schema';
import {
  ContactMergeService,
  MergePreview,
  MergeResult,
} from './merge/contact-merge.service';
import { CustomFieldValueValidator } from '../custom-fields/custom-field-value.validator';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { TagsService } from '../tags/tags.service';
import {
  PiiSearchPolicy,
  looksLikeProtectedValue,
} from '../common/search/pii-search.policy';
import { AuthorizationService } from '../common/permissions/authorization.service';
import { ContactIdentitySyncService } from './identities/contact-identity-sync.service';
import { normalizePhones } from '../common/identity/identity-normalizer';
import { ContactSegmentsService } from './segments/contact-segments.service';
import { randomUUID } from 'crypto';
import {
  UserSchemaClass,
  UserSchemaDocument,
} from '../users/infrastructure/persistence/document/entities/user.schema';
import { RecordWriteValidator } from '../object-manager/validation/record-write-validator.service';
import { PrincipalGroupsService } from '../object-manager/principal-groups.service';
import {
  buildContactExportQuery,
  buildContactExportSnapshot,
} from './export/contact-export-query';

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
    private readonly automationOutbox: AutomationOutboxService,
    private readonly exportStorageService: ContactExportStorageService,
    private readonly lockService: RedisLockService,
    private readonly entityAudit: EntityAuditService,
    private readonly activityLog: ActivityLogService,
    private readonly exportStorageFactory: ExportStorageFactory,
    private readonly importStorageFactory: ImportStorageFactory,
    private readonly mergeService: ContactMergeService,
    private readonly customFieldValidator: CustomFieldValueValidator,
    private readonly customFields: CustomFieldsService,
    private readonly tagsService: TagsService,
    private readonly authorization: AuthorizationService,
    private readonly identitySync: ContactIdentitySyncService,
    private readonly piiSearch: PiiSearchPolicy,
    @Inject(IOREDIS_CLIENT)
    private readonly redis: Redis,
    @InjectQueue(CONTACT_EXPORT_QUEUE)
    private readonly exportQueue: Queue,
    @InjectQueue(CONTACT_IMPORT_QUEUE)
    private readonly importQueue: Queue,
    @InjectModel(ImportJobSchemaClass.name)
    private readonly importJobModel: Model<ImportJobDocument>,
    @InjectModel(ExportJobSchemaClass.name)
    private readonly exportJobModel: Model<ExportJobDocument>,
    @InjectModel(UserSchemaClass.name)
    private readonly userModel: Model<UserSchemaDocument>,
    private readonly writeValidator: RecordWriteValidator,
    private readonly principalGroups: PrincipalGroupsService,
    private readonly segments: ContactSegmentsService,
  ) {
    this.exportStorage = this.exportStorageFactory.create('contacts');
    this.importStorage = this.importStorageFactory.create('contacts');
  }

  private readonly exportStorage: ExportStorageService;
  private readonly importStorage: ImportStorageService;

  /**
   * Tenant dialling code, resolved once per write.
   *
   * `contact_identity` is a tenant setting, so this is the only layer that can
   * reach it — the DTO transform that used to normalise phones could not, and
   * stored the national form the user typed while the import worker stored E.164.
   */
  private async normalizePhoneInput(
    phones: string[] | undefined,
  ): Promise<string[] | undefined> {
    if (phones === undefined) return undefined;
    return normalizePhones(phones, await this.resolveDefaultCountryCode());
  }

  async create(data: CreateContactDto): Promise<Contact> {
    await this.writeValidator.assertValid(
      'Contact',
      data as unknown as Record<string, unknown>,
      'create',
    );
    const normalizedLifecycle = await this.normalizeLifecycleFields(data);
    const ownerId = data.ownerId?.trim() || this.requireCurrentUserId();
    await this.assertMayTransferOwnership(null, ownerId);
    const orgUnitId = await this.resolveOwnerOrgUnit(ownerId);
    const emails = data.emails ?? [];
    const phones = (await this.normalizePhoneInput(data.phones)) ?? [];

    await this.assertIdentityIsUnique({ emails, phones });

    const customFields = await this.customFieldValidator.validate(
      'Contact',
      data.customFields,
    );

    const contact = await this.automationOutbox.runWithEvent(
      async (session) => {
        const created = await this.repository.create(
          {
            ...data,
            ...normalizedLifecycle,
            emails,
            phones,
            ownerId,
            orgUnitId,
            ...(customFields !== undefined ? { customFields } : {}),
          } as any,
          session,
        );
        await this.identitySync.syncFromContact(created.id, created as any, {
          source: 'api',
          session,
          strict: true,
          tenantId: (created as any).tenantId,
          userId: this.getCurrentUserId(),
        });
        return created;
      },
      (created) => this.buildAutomationEvent('record_created', created),
    );

    this.entityAudit.emit({
      entity: 'contact',
      entityType: 'CONTACT',
      entityId: contact.id,
      kind: 'created',
      newSnapshot: contact,
    });

    this.eventEmitter.emit('contact.created', {
      tenantId: (contact as any).tenantId,
      contactId: contact.id,
    });

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
      // Which `customFields.<key>` filters the repository may honour. Resolved
      // here, once per request, from the tenant's registry: the repository must
      // not accept an arbitrary dotted path — that reopens the field-injection
      // hole its whitelist exists to close — and an admin-defined field that
      // cannot be filtered is a field the product cannot actually use.
      __allowedCustomFieldKeys: await this.resolveCustomFieldKeys(filter),
      // Whether this caller may search the values field masking hides from
      // them. Resolved only when a search term is present, and only when that
      // term is shaped like a protected value — so an ordinary name search
      // costs no permission check and produces no audit noise.
      __canSearchSensitive: await this.resolveSensitiveSearch(filter?.search),
      // Compiled once per request. Composed with the list's own filters rather
      // than replacing them, so "this segment, owned by me" is one query.
      __segmentFilter: filter?.segmentId
        ? await this.segments.buildMembershipFilter(filter.segmentId)
        : undefined,
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

  /**
   * The `customFields` keys this tenant has declared, or undefined when the
   * request contains no custom-field filter.
   *
   * Skipping the registry read unless a `customFields.` filter is actually present
   * keeps the common list request at its previous cost — this runs on every page
   * of every contact list.
   */
  private async resolveCustomFieldKeys(
    filter: any,
  ): Promise<Set<string> | undefined> {
    const raw = filter?.filters;
    if (!raw) return undefined;
    const serialized = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (!serialized.includes('customFields.')) return undefined;

    try {
      const fields = await this.customFields.getByModule('Contact');
      return new Set(fields.map((f) => f.internalKey));
    } catch (err) {
      // Fail closed: an unreadable registry means custom-field filters are
      // refused, which returns a wider result set than intended but never leaks
      // a field the tenant did not define.
      this.logger.warn(
        `Could not load custom fields for filtering; custom-field filters ignored: ${
          (err as Error).message
        }`,
      );
      return undefined;
    }
  }

  async update(id: string, data: UpdateContactDto): Promise<Contact | null> {
    await this.writeValidator.assertValid(
      'Contact',
      data as unknown as Record<string, unknown>,
      'update',
    );
    const existingContact = await this.repository.findOne({ _id: id });
    // `findOne` is scoped by tenant, data-visibility and the ABAC deny, so a
    // miss means "not yours to edit" — and it has to be answered here.
    //
    // This path does NOT go through BaseDocumentRepository.update: it uses
    // `updateWithVersionCheck(id, existingContact?.version ?? 0, …)`. With no
    // pre-read the version defaulted to 0, the versioned write matched nothing,
    // and the caller was told `409 The contact was modified by another request`
    // — an authorization refusal reported as a concurrency clash, on the most
    // used entity in the product. 404 is the same answer every other module
    // gives, and it discloses nothing.
    if (!existingContact) {
      throw new NotFoundException(`Contact ${id} not found`);
    }
    const normalizedLifecycle = await this.normalizeLifecycleFields(
      data,
      existingContact ?? undefined,
    );
    // Sanitize ownerId: empty string is not a valid ObjectId
    if (data.ownerId === '') {
      throw new BadRequestException('A Contact must always have an owner.');
    }
    const ownerId = data.ownerId;
    const emails = data.emails;
    const phones = await this.normalizePhoneInput(data.phones);

    if (emails !== undefined || phones !== undefined) {
      await this.assertIdentityIsUnique({ emails, phones, excludeId: id });
    }

    await this.assertMayTransferOwnership(existingContact, ownerId);
    const ownerOrgUnitId =
      ownerId !== undefined &&
      String(existingContact?.ownerId ?? '') !== String(ownerId)
        ? await this.resolveOwnerOrgUnit(ownerId)
        : undefined;

    // `partial: true` — a PATCH that does not mention a required custom field
    // must not fail on it; the field was already satisfied at create time.
    const customFields = await this.customFieldValidator.validate(
      'Contact',
      data.customFields,
      { partial: true },
    );

    // Shadow contact promotion: when a shadow contact gets real data, promote it
    let additionalData: any = {};
    if (existingContact?.isShadow) {
      const hasNewEmail = emails && emails.length > 0;
      const hasNewPhone = phones && phones.length > 0;
      if (hasNewEmail || hasNewPhone) {
        additionalData = { isShadow: false };
      }
    }

    // updatedBy is auto-injected by BaseDocumentRepository from CLS
    const changedFields = Object.keys(data).filter((k) => k !== 'updatedBy');
    const updated = await this.automationOutbox.runWithEvent(
      async (session) => {
        const result = await this.repository.updateWithVersionCheck(
          id,
          existingContact?.version ?? 0,
          {
            ...data,
            ...normalizedLifecycle,
            ...additionalData,
            ...(emails !== undefined ? { emails } : {}),
            ...(phones !== undefined ? { phones } : {}),
            ...(customFields !== undefined ? { customFields } : {}),
            ...(ownerId !== undefined ? { ownerId } : {}),
            ...(ownerOrgUnitId !== undefined
              ? { orgUnitId: ownerOrgUnitId }
              : {}),
          },
          session,
        );
        if (!result) {
          throw new ConflictException(
            'The contact was modified by another request. Reload and try again.',
          );
        }
        if (result && (emails !== undefined || phones !== undefined)) {
          await this.identitySync.syncFromContact(result.id, result as any, {
            source: 'api',
            session,
            strict: true,
            tenantId: (result as any).tenantId,
            userId: this.getCurrentUserId(),
          });
        }
        return result;
      },
      (result) =>
        result
          ? this.buildAutomationEvent('field_updated', result, changedFields)
          : null,
    );

    if (updated) {
      this.entityAudit.emit({
        entity: 'contact',
        entityType: 'CONTACT',
        entityId: id,
        kind: 'updated',
        oldSnapshot: existingContact ?? {},
        newSnapshot: updated,
      });

      this.eventEmitter.emit('contact.updated', {
        tenantId: (updated as any).tenantId,
        contactId: updated.id,
      });

      // VIP is denormalised onto the contact's live conversations, because both
      // the inbox filter and the inbound routing context read it from there.
      // Emitted as an event rather than calling the omni repository directly:
      // contacts must not gain a dependency on omni-inbound, which already
      // depends on contacts.
      const previousVip = (existingContact as any)?.isVIP === true;
      const currentVip = (updated as any)?.isVIP === true;
      if (data.isVIP !== undefined && previousVip !== currentVip) {
        this.eventEmitter.emit('contact.vip_changed', {
          tenantId: String((updated as any).tenantId),
          contactId: updated.id,
          isVip: currentVip,
        });
      }
    }

    return updated;
  }

  /**
   * Reassigning a contact requires `contacts:assign`, not merely `contacts:edit`.
   *
   * Ownership is the primary data-visibility axis, so a transfer moves the record
   * between people's scopes — an agent with only `edit` could quietly pull records
   * into their own view or push a colleague's out of theirs, using the same
   * permission they use to correct a phone number. Salesforce separates this as
   * "Transfer Record" for the same reason.
   *
   * This is unconditional. `migrate:contact-assign-permission` must run before
   * deployment to grandfather existing editor roles where appropriate. A feature
   * flag here was fail-open security: an API caller could bypass the UI permission
   * in every tenant that had not explicitly enabled enforcement.
   */
  private async assertMayTransferOwnership(
    existing: Contact | null,
    nextOwnerId: string | undefined,
  ): Promise<void> {
    // Not a transfer: field absent, or unchanged.
    if (nextOwnerId === undefined) return;
    const userId = this.getCurrentUserId();
    if (existing) {
      if (String(existing.ownerId ?? '') === String(nextOwnerId ?? '')) return;
    } else if (String(nextOwnerId) === String(userId)) {
      return;
    }
    const decision = await this.authorization.canPerformAction({
      rule: { action: 'assign', resource: 'contacts' },
      rawUserId: String(userId ?? ''),
      tenantHint: this.resolveTenantId(),
    });

    if (!decision.allowed) {
      throw new ForbiddenException(
        'Changing the owner of a contact requires the contacts:assign permission.',
      );
    }
  }

  private async resolveOwnerOrgUnit(ownerId: string): Promise<string | null> {
    if (
      !Types.ObjectId.isValid(ownerId) &&
      ownerId !== this.getCurrentUserId()
    ) {
      throw new BadRequestException('ownerId is not a valid user id.');
    }
    if (String(ownerId) === String(this.getCurrentUserId())) {
      return this.cls.get('userOrgUnitId') ?? null;
    }

    const tenantId = this.resolveTenantId();
    const owner = await this.userModel
      .findOne({
        _id: ownerId,
        'tenants.tenantId': tenantId,
        deletedAt: { $exists: false },
      })
      // `tenants.$` projects only the membership that matched the filter —
      // the owner may belong to other tenants, each with its own placement.
      .select({ 'tenants.$': 1 })
      .lean()
      .exec();
    if (!owner) {
      throw new BadRequestException('ownerId is not an active tenant member.');
    }
    const orgUnitId = (owner.tenants?.[0] as any)?.orgUnitId;
    return orgUnitId ? String(orgUnitId) : null;
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
   *
   * Serialised on the identity, not the contact. The uniqueness rule below is a
   * read-then-write with no unique index behind it — `omniIdentities` is an array,
   * so a Mongo unique index on it would be per-element across the whole collection
   * and could not be tenant-scoped. Two agents linking the same channel account to
   * two different contacts therefore both passed the check and both wrote, which
   * permanently split that customer's conversation history across two records with
   * nothing to detect it. The lock is what the missing index would have done.
   */
  mergeIdentity(
    contactId: string,
    identity: { channelType: string; senderId: string },
  ): Promise<Contact> {
    const lockKey =
      `lock:contact:identity:${this.resolveTenantId()}:` +
      `${identity.channelType}:${identity.senderId}`;
    return this.lockService.acquire(lockKey, 10_000, () =>
      this.linkIdentity(contactId, identity),
    );
  }

  private async linkIdentity(
    contactId: string,
    identity: { channelType: string; senderId: string },
  ): Promise<Contact> {
    const contact = await this.repository.findOne({ _id: contactId });
    if (!contact) {
      throw new NotFoundException(`Contact ${contactId} not found`);
    }

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

  /**
   * Enforce the tenant's `contact_identity` policy: reject a write that would
   * give two contacts the same email or phone number.
   *
   * This existed only inside the import worker. The setting is surfaced in
   * Settings → Object Manager → Advanced Contact as a workspace-wide identity
   * policy, so a tenant that switched "unique email" on reasonably expected it to
   * hold everywhere; instead every non-import path ignored it and the duplicates
   * it was meant to prevent arrived through the UI, the API and the omni
   * pipeline.
   *
   * Application-level rather than a unique index, deliberately: `emails` is an
   * array, so a Mongo unique index on it is per-element across the collection
   * and cannot be scoped to a tenant without a partial expression per tenant.
   * The trade-off is a TOCTOU window under concurrent writes; that is acceptable
   * for a data-quality rule (the duplicate is then reported by
   * `checkDuplicate`), and is why the import path additionally holds a per-tenant
   * lock.
   */
  private async assertIdentityIsUnique(params: {
    emails?: string[];
    phones?: string[];
    excludeId?: string;
  }): Promise<void> {
    const conflicts: string[] = [];

    for (const email of params.emails ?? []) {
      const existing = await this.repository.findDuplicateByIdentity(
        'emails',
        email,
        params.excludeId,
      );
      if (existing) {
        conflicts.push(
          `email ${email} already belongs to ${existing.firstName} ${existing.lastName}`,
        );
      }
    }

    for (const phone of params.phones ?? []) {
      const existing = await this.repository.findDuplicateByIdentity(
        'phones',
        phone,
        params.excludeId,
      );
      if (existing) {
        conflicts.push(
          `phone ${phone} already belongs to ${existing.firstName} ${existing.lastName}`,
        );
      }
    }

    if (conflicts.length > 0) {
      throw new ConflictException({
        message: 'Contact identity conflict',
        conflicts,
      });
    }
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
   * There is no separate Lead entity — "conversion" is just a stage
   * transition. Records a stage history entry for conversion rate and
   * velocity tracking.
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

    const { direction, skippedStages } = this.computeTransitionDirection(
      validStages,
      previousStageName,
      stage.apiName,
    );

    const changedById = this.cls.get('user.id') ?? contact.updatedById;

    let finalAccountId = params?.accountId;

    if (params?.createAccount && params?.accountData) {
      const account = await this.accountsService.create(params.accountData);
      finalAccountId = account.id;
    }

    const updated = await this.applyStageUpdate(
      id,
      contact,
      stage,
      finalAccountId,
    );

    const dealId = await this.recordStageTransitionSideEffects(id, {
      contact,
      updated,
      previousStageName,
      stage,
      changedById,
      reason: params?.reason,
      direction,
      skippedStages,
      finalAccountId,
      dealData: params?.dealData,
    });

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
   * Apply the stage update with optimistic locking and default status resolution.
   *
   * Wrapped in the automation outbox like every other Contact write. It was not,
   * and the omission removed the single most valuable trigger a B2C tenant has:
   * "lifecycle stage became Customer → send the welcome sequence" never fired,
   * because a stage change reached the database without ever producing a
   * `field_updated.Contact` event. The internal `contact.stage.changed` event has
   * exactly one listener — the projector that writes `contact_stage_transitions`
   * — and no bridge into the workflow engine.
   */
  private async applyStageUpdate(
    id: string,
    contact: Contact,
    stage: any,
    finalAccountId?: string,
  ): Promise<Contact> {
    const sortedStatuses = this.sortBySortOrder<any>(stage.statuses ?? []);
    const defaultStatus =
      sortedStatuses.find((status: any) => status.isDefault) ??
      sortedStatuses[0];

    const changedFields = [
      'lifecycleStageId',
      ...(defaultStatus ? ['statusId'] : []),
      ...(finalAccountId ? ['accountId'] : []),
    ];

    return this.automationOutbox.runWithEvent(
      async (session) => {
        const updated = await this.repository.updateWithVersionCheck(
          id,
          contact.version ?? 0,
          {
            lifecycleStageId: stage.apiName,
            ...(defaultStatus ? { statusId: defaultStatus.apiName } : {}),
            ...(finalAccountId ? { accountId: finalAccountId } : {}),
          } as any,
          session,
        );
        if (!updated) {
          throw new ConflictException(
            'Stage was updated concurrently by another user. Please reload and try again.',
          );
        }
        return updated;
      },
      (updated) =>
        this.buildAutomationEvent('field_updated', updated, changedFields),
    );
  }

  /** Record stage history, emit audit event, and optionally create a deal. */
  private async recordStageTransitionSideEffects(
    id: string,
    ctx: {
      contact: Contact;
      updated: Contact;
      previousStageName: string | null;
      stage: any;
      changedById: string;
      reason?: string;
      direction: 'forward' | 'backward' | 'lateral';
      skippedStages: string[];
      finalAccountId?: string;
      dealData?: any;
    },
  ): Promise<string | undefined> {
    const occurredAt = new Date();
    await this.repository.pushStageHistory(id, {
      fromStage: ctx.previousStageName,
      toStage: ctx.stage.apiName,
      changedAt: occurredAt,
      changedById: ctx.changedById,
      reason: ctx.reason,
      direction: ctx.direction,
      skippedStages:
        ctx.skippedStages.length > 0 ? ctx.skippedStages : undefined,
    });
    this.eventEmitter.emit('contact.stage.changed', {
      eventId: randomUUID(),
      tenantId: this.resolveTenantId(),
      contactId: id,
      fromStage: ctx.previousStageName,
      toStage: ctx.stage.apiName,
      occurredAt,
      changedById: ctx.changedById,
      reason: ctx.reason,
      direction: ctx.direction,
      skippedStages: ctx.skippedStages,
    });
    // Stage change is NOT written to Activity Log.
    // Sales timeline uses Virtual Activity (pulled from stageHistory[]).
    // Audit Trail captures field-level diff (lifecycleStageId) automatically.

    // AuditLogListener will compute old vs new snapshot → audit_logs
    this.entityAudit.emit({
      entity: 'contact',
      entityType: 'CONTACT',
      entityId: id,
      kind: 'updated',
      oldSnapshot: ctx.contact,
      newSnapshot: ctx.updated,
    });

    await this.repository.touchLastActivity(id, occurredAt);

    if (ctx.dealData && ctx.updated) {
      // `contactIds`, plural. This used to pass `contactId`, which the deal
      // schema does not have, so Mongoose dropped it in strict mode and every
      // deal produced by a lead conversion was linked to no contact at all.
      //
      // The source is carried across for the same reason: without it the
      // channel that produced the lead is lost at the exact moment the lead
      // becomes revenue, which is the one join attribution reporting needs.
      const deal = await this.dealsService.create({
        sourceId: ctx.contact.sourceId,
        ...ctx.dealData,
        contactIds: [ctx.updated.id],
        accountId: ctx.finalAccountId,
      });
      return deal.id;
    }

    return undefined;
  }

  /**
   * Compute the direction of a lifecycle stage transition and any
   * skipped stages for non-sequential jumps.
   */
  private computeTransitionDirection(
    validStages: string[],
    fromStageName: string | null,
    toStageName: string,
  ): {
    direction: 'forward' | 'backward' | 'lateral';
    skippedStages: string[];
  } {
    const fromIndex = fromStageName ? validStages.indexOf(fromStageName) : -1;
    const toIndex = validStages.indexOf(toStageName);

    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
      return { direction: 'lateral', skippedStages: [] };
    }

    if (toIndex > fromIndex) {
      const skipped =
        toIndex - fromIndex > 1
          ? validStages.slice(fromIndex + 1, toIndex)
          : [];
      return { direction: 'forward', skippedStages: skipped };
    }

    const skipped =
      fromIndex - toIndex > 1 ? validStages.slice(toIndex + 1, fromIndex) : [];
    return { direction: 'backward', skippedStages: skipped };
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

    // fields_unmasked is a compliance/system action — not written to Activity Log.

    return { fields: rawFields };
  }

  /**
   * Reject tag values that are not ids from the tenant's tag catalogue.
   *
   * `contact.tags[]` holds tag IDs — `TagUsageService` counts and cleans up
   * references by id, and tag deletion rewrites them by id. This endpoint used to
   * `$addToSet` whatever trimmed strings it was given, so `tags[]` ended up a
   * mixture of ids and free-text labels depending on which endpoint had written
   * last. The free-text entries were invisible to the tag catalogue: they could
   * not be renamed, counted, or cleaned up when the tag was deleted, and they
   * rendered as raw ids-that-aren't-ids in the UI.
   */
  private async assertTagsExist(tagIds: string[]): Promise<void> {
    const catalogue = await this.tagsService.findAll({ scope: 'Contact' });
    const known = new Set(catalogue.map((tag) => String(tag.id)));
    const unknown = tagIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown tag id(s): ${unknown.join(', ')}. ` +
          'Create the tag in the tag catalogue first — contact.tags stores ids, not labels.',
      );
    }
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

    await this.assertTagsExist(tags);

    // Read the rows we are about to change, scoped — `addTagsToContacts` uses
    // `updateMany`, which no audit hook and no automation outbox observes. The
    // previous version relied on a comment claiming audit_logs already captured
    // the diff; nothing wrote one, so tagging 500 customers left no trace and
    // fired no workflow. "Tag added" is the most common B2C automation trigger
    // there is.
    const before = await this.repository.findByIds(contactIds);
    if (before.length === 0) {
      return { success: true, matchedCount: 0, modifiedCount: 0 };
    }
    const scopedIds = before.map((contact) => contact.id);

    const { result, changed } = await this.automationOutbox.runWithEvents(
      async (session) => {
        const writeResult = await this.repository.addTagsToContacts(
          scopedIds,
          tags,
          session,
        );
        const after = await this.repository.findByIds(scopedIds, session);
        const afterById = new Map(
          after.map((contact) => [contact.id, contact]),
        );

        // Only contacts that actually gained a tag: `$addToSet` is a no-op for
        // one that already had it, and an event for a change that did not happen
        // is how a workflow fires twice for one customer.
        const changedPairs = before
          .map((previous) => ({
            previous,
            updated: afterById.get(previous.id),
          }))
          .filter(
            (pair): pair is { previous: Contact; updated: Contact } =>
              !!pair.updated &&
              (pair.updated.tags?.length ?? 0) >
                (pair.previous.tags?.length ?? 0),
          );

        return {
          result: { result: writeResult, changed: changedPairs },
          payloads: changedPairs
            .map(({ updated }) =>
              this.buildAutomationEvent('field_updated', updated, ['tags']),
            )
            .filter((payload): payload is AutomationEventPayload => !!payload),
        };
      },
    );

    for (const { previous, updated } of changed) {
      this.entityAudit.emit({
        entity: 'contact',
        entityType: 'CONTACT',
        entityId: previous.id,
        kind: 'updated',
        oldSnapshot: previous,
        newSnapshot: updated,
      });
    }

    return {
      success: true,
      ...result,
    };
  }

  async exportContacts(
    params: ExportContactsDto,
  ): Promise<{ jobId: string; status: 'queued' }> {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    const userId = this.getCurrentUserId();

    await this.enforceExportQuota(userId);

    const tenantConfig =
      await this.settingsService.getSetting('data_access_policy');
    const restrictToOwner = tenantConfig?.restrict_own_contacts ?? false;

    // Preserve the existing repository filter shape (incl. the legacy magic
    // keys the export filter builder understands).
    const legacyFilters = buildContactExportQuery(params, {
      restrictToOwner,
      currentUserId: userId,
      // Export shares buildListWhere with the list view, so it needs the same
      // registry allow-list or a custom-field filter would be silently dropped
      // and the export would quietly cover more rows than the user selected.
      allowedCustomFieldKeys: await this.resolveCustomFieldKeys(params),
      segmentFilter: params.segmentId
        ? await this.segments.buildMembershipFilter(params.segmentId)
        : undefined,
    });

    const filterSnapshot = buildContactExportSnapshot(params, restrictToOwner);

    const format = params.format ?? 'csv';
    const job = await this.exportQueue.add('export', {
      tenantId,
      userId,
      groupIds: await this.principalGroups.groupIds(),
      format,
      columns: params.columns,
      filter: { ids: params.ids, restrictToOwner, currentUserId: userId },
      ids: params.ids,
      legacyFilters,
    });

    // Persist the export_jobs document — this doubles as the audit record.
    await this.exportJobModel.create({
      tenantId,
      userId,
      groupIds: await this.principalGroups.groupIds(),
      entityType: 'contact',
      format,
      status: 'queued',
      bullJobId: String(job.id),
      filterSnapshot,
      selectedColumns: params.columns,
      ip: this.cls.get('requestIp'),
      userAgent: this.cls.get('userAgent'),
    });

    // Bulk export is a data-exfiltration action → always audited.
    await this.activityLog.create({
      targetType: 'Export',
      targetId: String(job.id),
      event: 'export',
      actorId: userId,
      payload: { module: 'contact', filter: filterSnapshot },
    });

    return { jobId: String(job.id), status: 'queued' };
  }

  /**
   * Throttle exports per tenant (concurrent) and per user (hourly) to stop one
   * tenant from monopolising export workers via sequential spam.
   */
  private async enforceExportQuota(userId: string | undefined): Promise<void> {
    const maxQueued = Number(process.env.EXPORT_MAX_QUEUED_PER_TENANT ?? 3);
    const maxPerHour = Number(process.env.EXPORT_MAX_PER_USER_PER_HOUR ?? 5);

    // Both queries run in the request's CLS context → auto-scoped to tenant.
    const inFlight = await this.exportJobModel.countDocuments({
      entityType: 'contact',
      status: { $in: ['queued', 'active'] },
    });
    if (inFlight >= maxQueued) {
      throw new HttpException(
        'Too many exports in progress for this workspace. Please wait for one to finish.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const since = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await this.exportJobModel.countDocuments({
      entityType: 'contact',
      userId,
      createdAt: { $gte: since },
    });
    if (recent >= maxPerHour) {
      throw new HttpException(
        'Export rate limit reached. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
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

    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
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

  /** Request cancellation of a running export (worker checks each batch). */
  async cancelExport(jobId: string): Promise<{ status: string }> {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    const userId = this.getCurrentUserId();

    const doc = await this.exportJobModel
      .findOne({ bullJobId: jobId })
      .lean()
      .exec();
    if (
      !doc ||
      String(doc.tenantId) !== String(tenantId) ||
      String(doc.userId) !== String(userId)
    ) {
      throw new NotFoundException('Export job not found');
    }
    if (['completed', 'failed', 'cancelled'].includes(doc.status)) {
      return { status: doc.status };
    }

    await ExportProgressTracker.requestCancel(this.redis, jobId);
    return { status: 'cancelling' };
  }

  async listExportJobs(options: {
    page?: number;
    limit?: number;
    status?: string;
  }): Promise<{ data: any[]; total: number; page: number; limit: number }> {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    const userId = this.getCurrentUserId();
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(50, Math.max(1, options.limit ?? 10));
    const skip = (page - 1) * limit;

    const filter: Record<string, any> = {
      tenantId,
      userId,
      entityType: 'contact',
    };
    if (
      options.status &&
      ['queued', 'active', 'completed', 'failed', 'cancelled'].includes(
        options.status,
      )
    ) {
      filter.status = options.status;
    }

    const [data, total] = await Promise.all([
      this.exportJobModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'firstName lastName email avatar')
        .lean()
        .exec(),
      this.exportJobModel.countDocuments(filter).exec(),
    ]);

    await this.enrichJobsWithBullProgress(data, this.exportQueue);

    // .lean() strips Mongoose virtuals/transforms, so ObjectId fields remain
    // as raw buffer objects. Sanitize them to plain strings for the API.
    const sanitized = this.sanitizeLeanJobDocs(data);

    return { data: sanitized, total, page, limit };
  }

  async getExportDownload(
    token: string,
  ): ReturnType<ExportStorageService['openLocalExport']> {
    // export_downloaded: system action — not written to Activity Log.
    return this.exportStorage.openLocalExport(token);
  }

  // CONTACT IMPORT

  /**
   * Store an uploaded .csv/.xlsx and return its storage key plus the parsed
   * header row so the client can build the field-mapping UI.
   */
  async uploadImportFile(file: {
    path: string;
    originalname: string;
    size: number;
  }): Promise<{ fileKey: string; format: string; headers: string[] }> {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    try {
      if (file.size > IMPORT_MAX_FILE_BYTES) {
        throw new BadRequestException(
          `File exceeds the ${IMPORT_MAX_FILE_BYTES / (1024 * 1024)}MB limit`,
        );
      }
      const format = detectFormat(file.originalname);
      // Both header parsing and persistence consume streams from disk. Peak API
      // heap is therefore independent of the uploaded file size.
      const parser = createParser(format);
      const headers = await parser.readHeaders(createReadStream(file.path));
      if (headers.length === 0) {
        throw new BadRequestException('File has no header row');
      }

      const { fileKey } =
        await this.exportStorageService.storeImportFileFromPath({
          path: file.path,
          size: file.size,
          originalname: file.originalname,
          tenantId: this.resolveTenantId(),
          userId: this.requireCurrentUserId(),
        });

      return { fileKey, format, headers };
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
  }

  async startImport(
    dto: StartImportDto,
  ): Promise<{ jobId: string; status: 'queued' }> {
    const mappedFields = await this.validateImportMapping(dto.mapping);
    this.validateDedupConfig(dto.deduplication, mappedFields);

    await this.validateFileExists(dto.fileKey);

    // Snapshot tenant identity settings AT ENQUEUE TIME so the worker never
    // queries crm_settings inside its hot loop (latency + consistency).
    const tenantSettings = await this.fetchImportTenantSettings();
    // The vocabulary a file's text values resolve against — stage/status/source
    // names, tag names, custom-field types. Snapshotted for the same reason as
    // the settings above: the worker must not query per row, and a rename
    // mid-import must not change how the rest of the file is interpreted.
    const catalog = await this.buildImportCatalog();

    const tenantId = this.resolveTenantId();
    const userId = this.requireCurrentUserId();
    const ownerId = dto.ownerId ?? userId;
    await this.assertMayTransferOwnership(null, ownerId);
    const orgUnitId = await this.resolveOwnerOrgUnit(ownerId);
    const jobId = `contact-import-${randomUUID()}`;
    const jobData = {
      tenantId: this.resolveTenantId(),
      userId,
      // Ownership is resolved HERE, in the request, and carried on the job.
      // The worker has no CLS context to derive it from, and an unowned contact
      // is invisible to every scoped user.
      ownerId,
      orgUnitId,
      fileKey: dto.fileKey,
      mapping: dto.mapping,
      deduplication: dto.deduplication,
      dryRun: dto.dryRun ?? false,
      triggerAutomations: dto.triggerAutomations ?? false,
      estimatedRows: dto.estimatedRows,
      fileName: this.resolveImportFileName(dto),
      tenantSettings,
      catalog,
    };

    // The checkpoint is part of every Contact batch transaction, so its durable
    // job record must exist BEFORE a worker can start. The former enqueue-first,
    // best-effort create had a race where a fast worker (or a Mongo create
    // failure) could never persist a checkpoint and retried forever.
    await this.importJobModel.create({
      tenantId,
      userId,
      fileName: this.resolveImportFileName(dto),
      fileFormat: this.resolveImportFileFormat(dto),
      rowCount: dto.estimatedRows ?? 0,
      status: 'queued',
      bullJobId: jobId,
      dryRun: dto.dryRun ?? false,
      mapping: dto.mapping,
      deduplication: dto.deduplication,
      triggerAutomations: dto.triggerAutomations ?? false,
      ip: this.cls.get('requestIp'),
      userAgent: this.cls.get('userAgent'),
    });

    try {
      await this.importQueue.add('import', jobData, { jobId });
    } catch (err) {
      // Compensate only the record created above. The upload remains available
      // so the caller can retry without uploading 50 MB again.
      await this.importJobModel
        .deleteOne({ bullJobId: jobId, tenantId, userId })
        .catch(() => undefined);
      throw err;
    }

    return { jobId, status: 'queued' };
  }

  // IMPORT HISTORY

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
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
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
        .populate('userId', 'firstName lastName email avatar')
        .lean()
        .exec(),
      this.importJobModel.countDocuments(filter).exec(),
    ]);

    await this.enrichJobsWithBullProgress(data, this.importQueue);

    const sanitized = this.sanitizeLeanJobDocs(data);

    return { data: sanitized, total, page, limit };
  }

  async getImportJobDetail(id: string) {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    const userId = this.getCurrentUserId();

    const doc = await this.importJobModel
      .findOne({ _id: id, tenantId, userId })
      .lean()
      .exec();
    if (!doc) throw new NotFoundException('Import job not found');

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

  private async validateImportMapping(
    mapping: Record<string, string> | undefined,
  ): Promise<Set<string>> {
    const mappedFields = new Set(Object.values(mapping ?? {}));
    if (!mappedFields.has('firstName') || !mappedFields.has('lastName')) {
      throw new BadRequestException(
        'mapping must include both firstName and lastName',
      );
    }

    // Every mapped target must be a real field. Unknown targets used to be
    // dropped in the worker, so a mis-mapped column produced a clean-looking
    // import that silently discarded the data in it.
    const declaredCustomKeys = new Set(
      (await this.customFields.getByModule('Contact')).map(
        (field) => field.internalKey,
      ),
    );
    const unknown = [...mappedFields].filter((field) => {
      if (field.startsWith(IMPORT_CUSTOM_FIELD_PREFIX)) {
        return !declaredCustomKeys.has(
          field.slice(IMPORT_CUSTOM_FIELD_PREFIX.length),
        );
      }
      return !(IMPORT_MAPPABLE_FIELDS as readonly string[]).includes(field);
    });
    if (unknown.length) {
      throw new BadRequestException(
        `Unknown mapping target(s): ${unknown.join(', ')}`,
      );
    }

    return mappedFields;
  }

  private validateDedupConfig(dedup: any, mappedFields: Set<string>): void {
    if (!dedup) return;
    const allowed = new Set(['emails', 'phones', 'externalId']);
    const bad = dedup.matchingFields.filter((f: string) => !allowed.has(f));
    if (bad.length) {
      throw new BadRequestException(
        `Unsupported dedup matchingFields: ${bad.join(', ')}`,
      );
    }
    const missing = dedup.matchingFields.filter(
      (f: string) => !mappedFields.has(f),
    );
    if (missing.length) {
      throw new BadRequestException(
        `Dedup field(s) [${missing.join(', ')}] are not present in the column mapping`,
      );
    }
  }

  private async validateFileExists(fileKey: string): Promise<void> {
    this.exportStorageService.assertImportFileOwned(
      fileKey,
      this.resolveTenantId(),
      this.requireCurrentUserId(),
    );
    const exists = await this.exportStorageService.importFileExists(fileKey);
    if (!exists) {
      throw new BadRequestException(
        'fileKey not found in storage — upload the file again',
      );
    }
  }

  /**
   * Whether a search term shaped like a phone number or e-mail may be matched
   * against the masked half of the index.
   *
   * Masking stopped a user reading a contact's phone number, and did nothing to
   * stop the same user typing that number into the search box and being shown
   * whose it is. `contacts:unmask` already gates reading it; this makes it gate
   * the lookup too.
   */
  private async resolveSensitiveSearch(search?: string): Promise<boolean> {
    if (!search || !looksLikeProtectedValue(search)) return false;
    const allowed = await this.piiSearch.canSearchSensitive('contacts');
    if (!allowed) this.piiSearch.recordDeniedLookup('contacts', search);
    return allowed;
  }

  /**
   * The tenant's default country code, from the same `contact_identity` setting
   * the import and identity-sync paths already read.
   *
   * Never throws: a phone search that cannot resolve the code still works for
   * the international and bare-digit forms, so an unreadable setting must
   * degrade the match rather than fail the list request.
   */
  private async resolveDefaultCountryCode(): Promise<string | undefined> {
    try {
      const identity =
        await this.settingsService.getSetting('contact_identity');
      const code = (identity as { defaultCountryCode?: unknown })
        ?.defaultCountryCode;
      return typeof code === 'string' && code.trim() ? code : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The tenant vocabulary an import file's text is resolved against.
   *
   * A CSV column holds "Facebook Ads" or "Customer"; the database holds an
   * apiName or a tag id. Built once per job, in request context, so the worker
   * never queries settings per row.
   *
   * Keyed on the lower-cased label AND the lower-cased apiName, because a file
   * exported from this product carries apiNames while a file a human typed
   * carries labels, and both have to land.
   */
  private async buildImportCatalog(): Promise<ImportCatalog> {
    const [lifecycle, sourceSettings, tags, customFields] = await Promise.all([
      this.getContactLifecycle(),
      this.settingsService.getSetting('contact_source'),
      this.tagsService.findAll({ scope: 'Contact' }),
      this.customFields.getByModule('Contact'),
    ]);

    const lifecycleStages: Record<string, string> = {};
    const statuses: Record<string, string> = {};
    for (const stage of lifecycle?.stages ?? []) {
      for (const key of [stage.label, stage.name, stage.apiName]) {
        if (key) lifecycleStages[String(key).toLowerCase()] = stage.apiName;
      }
      for (const status of stage.statuses ?? []) {
        for (const key of [status.label, status.name, status.apiName]) {
          if (key) statuses[String(key).toLowerCase()] = status.apiName;
        }
      }
    }

    const sources: Record<string, string> = {};
    for (const source of sourceSettings?.sources ?? []) {
      for (const key of [source.name, source.id]) {
        if (key) sources[String(key).toLowerCase()] = String(source.id);
      }
    }

    return {
      lifecycleStages,
      statuses,
      sources,
      tags: Object.fromEntries(
        tags.map((tag) => [String(tag.name).toLowerCase(), String(tag.id)]),
      ),
      customFields: Object.fromEntries(
        customFields.map((field) => [field.internalKey, field.fieldType]),
      ),
    };
  }

  private async fetchImportTenantSettings(): Promise<ImportTenantSettings> {
    const identity =
      (await this.settingsService.getSetting('contact_identity')) ?? {};
    return {
      // Normalized identities have an unconditional tenant-scoped unique index.
      // Keeping these false in a queued snapshot would promise behavior Mongo
      // correctly refuses, so exact identity uniqueness is now one invariant.
      uniqueEmail: true,
      uniquePhone: true,
      multipleEmailsAllowed: identity.multipleEmailsAllowed ?? false,
      multiplePhonesAllowed: identity.multiplePhonesAllowed ?? false,
      defaultCountryCode: identity.defaultCountryCode,
    };
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
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
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
  ): ReturnType<ImportStorageService['openLocalReport']> {
    return this.importStorage.openLocalReport(token);
  }

  /**
   * Merge two contacts.
   *
   * Delegates to ContactMergeService, which re-parents every related record,
   * resolves field-level survivorship, and writes a reversible ledger entry.
   * The previous inline implementation lived here and unioned four array fields
   * without touching a single referencing collection — notes, tickets, deals,
   * tasks, conversations and email bodies were left pointing at the archived
   * contact, unreachable but not deleted.
   */
  mergeContacts(
    primaryId: string,
    targetId: string,
    options?: { fieldWinners?: Record<string, 'survivor' | 'merged'> },
  ): Promise<MergeResult> {
    return this.mergeService.merge(primaryId, targetId, options ?? {});
  }

  /** Non-destructive merge preview — same code path, nothing written. */
  previewMerge(
    primaryId: string,
    targetId: string,
    options?: { fieldWinners?: Record<string, 'survivor' | 'merged'> },
  ): Promise<MergePreview> {
    return this.mergeService.preview(primaryId, targetId, options ?? {});
  }

  /** Reverse a merge, restoring the merged-away contact and its records. */
  unmergeContacts(mergeId: string): Promise<{
    success: true;
    restoredId: string;
  }> {
    return this.mergeService.unmerge(mergeId);
  }

  recoverFailedMerge(
    mergeId: string,
  ): Promise<{ success: true; status: 'compensated' }> {
    return this.mergeService.recoverFailed(mergeId);
  }

  /** Merge history for a contact, as survivor or as merged-away record. */
  getMergeHistory(contactId: string): Promise<any[]> {
    return this.mergeService.history(contactId);
  }

  // RECYCLE BIN

  /**
   * List soft-deleted contacts. `remove()` is a soft delete, so a mis-click is
   * recoverable for the retention window (CONTACT_PURGE_RETENTION_DAYS, 30 by
   * default) after which ContactPurgeService removes it and cascades.
   */
  async listDeleted(options: { page?: number; limit?: number }): Promise<{
    data: Contact[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(100, Math.max(1, options.limit ?? 25));
    const { data, total } = await this.repository.findDeleted({ page, limit });
    return { data, total, page, limit };
  }

  async restore(id: string): Promise<Contact> {
    const restored = await this.repository.restore(id);
    if (!restored) {
      throw new NotFoundException(
        'Contact not found in the recycle bin — it may already have been purged',
      );
    }

    this.entityAudit.emit({
      entity: 'contact',
      entityType: 'CONTACT',
      entityId: id,
      kind: 'updated',
      oldSnapshot: { _deleted: true } as any,
      newSnapshot: restored,
    });

    return restored;
  }

  private buildAutomationEvent(
    event: 'record_created' | 'field_updated',
    record: Contact,
    changedFields?: string[],
  ): AutomationEventPayload | null {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    if (!tenantId) {
      throw new Error('Tenant context is required for Contact automation.');
    }

    const payload: AutomationEventPayload = {
      tenantId,
      event,
      object: 'Contact',
      recordId: record.id,
      data: record as any,
      ...(changedFields ? { changedFields } : {}),
      automationDepth: 0,
      // Feeds `runAs: 'trigger_user'`. Read from CLS at emit time because the
      // queue worker that evaluates this event has no request to read it from.
      triggerUserId: this.cls.get('userId') ?? null,
    };

    return payload;
  }

  /**
   * Enrich active/queued job docs with real-time BullMQ state and progress.
   * Shared between export and import job listing endpoints.
   */
  private async enrichJobsWithBullProgress(
    docs: any[],
    queue: Queue,
  ): Promise<void> {
    for (const doc of docs) {
      if (doc.status !== 'active' && doc.status !== 'queued') continue;
      try {
        const bullJob = await queue.getJob(doc.bullJobId);
        if (!bullJob) continue;
        doc.status = await bullJob.getState();
        if (bullJob.progress && typeof bullJob.progress === 'object') {
          doc.progress = bullJob.progress;
        }
      } catch {
        // BullMQ job may have been cleaned up — keep MongoDB status
      }
    }
  }

  /**
   * Sanitize Mongoose .lean() documents for the API: convert ObjectIds to
   * strings, extract populated user objects, and strip internal fields.
   */
  private sanitizeLeanJobDocs(docs: any[]): any[] {
    return docs.map((doc) => {
      const out = { ...doc };
      out.id = String(doc._id);
      delete out._id;
      delete out.__v;
      if (doc.tenantId) out.tenantId = String(doc.tenantId);
      // Preserve populated user object; stringify only if still an ObjectId
      if (
        doc.userId &&
        typeof doc.userId === 'object' &&
        doc.userId.firstName
      ) {
        out.user = {
          firstName: doc.userId.firstName,
          lastName: doc.userId.lastName,
          email: doc.userId.email,
          avatar: doc.userId.avatar,
        };
        out.userId = String(doc.userId._id);
      } else if (doc.userId) {
        out.userId = String(doc.userId);
      }
      return out;
    });
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
      tenantId: this.cls.get('activeTenantId') ?? this.cls.get('tenantId'),
      actorId: input.actorId ?? this.getCurrentUserId(),
    });
  }

  private resolveTenantId(): string {
    return this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
  }

  /** Resolve a display filename from DTO, falling back to the fileKey basename. */
  private resolveImportFileName(dto: StartImportDto): string {
    return dto.fileName ?? dto.fileKey.split('/').pop() ?? 'unknown';
  }

  /** Resolve the import file format from the DTO or infer from fileKey extension. */
  private resolveImportFileFormat(dto: StartImportDto): string {
    return dto.fileFormat ?? (dto.fileKey.endsWith('.xlsx') ? 'xlsx' : 'csv');
  }

  private getCurrentUserId(): string | undefined {
    return this.cls.get('userId') ?? this.cls.get('user.id');
  }

  private requireCurrentUserId(): string {
    const userId = this.getCurrentUserId();
    if (!userId) {
      throw new ForbiddenException('Authenticated user context is required');
    }
    return userId;
  }
}
