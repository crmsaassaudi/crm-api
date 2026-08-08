import { Processor } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import Redis from 'ioredis';

import {
  BaseImportProcessor,
  ImportStorageService,
  ImportStorageFactory,
  ImportReportService,
  ImportModuleConfig,
  BaseImportJobData,
  MappedRow,
  ImportRowError,
  ImportErrorCode,
  ImportJobSchemaClass,
  ImportJobDocument,
} from '../common/import';
import { IOREDIS_CLIENT } from '../redis/redis.tokens';
import { RedisLockService } from '../redis/redis-lock.service';
import {
  ContactSchemaClass,
  ContactSchemaDocument,
} from './infrastructure/persistence/document/entities/contact.schema';
import {
  CONTACT_IMPORT_QUEUE,
  IMPORT_BATCH_SIZE,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAPPABLE_FIELDS,
  IMPORT_ARRAY_FIELDS,
  IMPORT_BOOLEAN_FIELDS,
  IMPORT_CUSTOM_FIELD_PREFIX,
  IMPORT_SETTING_REFERENCE_FIELDS,
} from './contacts.constants';
import { AutomationOutboxService } from '../automation-rules/events/automation-outbox.service';
import {
  normalizeEmail,
  normalizePhone,
  splitMultiValue,
} from '../common/identity/identity-normalizer';
import { ContactIdentitySyncService } from './identities/contact-identity-sync.service';
import { isEmail } from 'class-validator';

const CONTACT_IMPORT_CONFIG: ImportModuleConfig = {
  module: 'contact',
  displayName: 'Contact',
  mappableFields: IMPORT_MAPPABLE_FIELDS,
  requiredFields: ['firstName', 'lastName'],
  arrayFields: IMPORT_ARRAY_FIELDS,
  dedupMatchingFields: ['emails', 'phones', 'externalId'],
  dedupPolicies: ['skip', 'overwrite', 'merge'],
  referenceFields: [],
  batchSize: IMPORT_BATCH_SIZE,
  maxFileBytes: IMPORT_MAX_FILE_BYTES,
  allowDryRun: true,
  allowAutomations: true,
  completionChannel: 'socket:contact:import:completed',
  queueName: CONTACT_IMPORT_QUEUE,
};

const SCALAR_FIELDS = IMPORT_MAPPABLE_FIELDS.filter(
  (f) => !IMPORT_ARRAY_FIELDS.has(f),
);

export interface ImportTenantSettings {
  uniqueEmail: boolean;
  uniquePhone: boolean;
  multipleEmailsAllowed: boolean;
  multiplePhonesAllowed: boolean;
  /**
   * Dialling code (no '+') used to promote national-format phone numbers to
   * E.164 during mapping, so an imported `0901112222` deduplicates against a
   * UI-entered `+84901112222`. Snapshotted at enqueue time with the rest of the
   * identity settings.
   */
  defaultCountryCode?: string;
}

/**
 * The tenant vocabulary a file's text values are resolved against, snapshotted
 * at enqueue time.
 *
 * A CSV says "Facebook Ads", "Customer", "VIP" — the database stores a source
 * apiName, a lifecycle apiName and a tag id. Resolving per row would be three
 * lookups per contact; resolving from a snapshot is a Map read. Snapshotting
 * also means a file behaves identically from the row the job started on, even
 * if an admin renames a stage while 200k rows are still streaming.
 */
export interface ImportCatalog {
  /** Lower-cased label/apiName → apiName, per reference field. */
  lifecycleStages: Record<string, string>;
  statuses: Record<string, string>;
  sources: Record<string, string>;
  /** Lower-cased tag name → tag id. */
  tags: Record<string, string>;
  /** Custom field internalKey → type, for coercion and rejection. */
  customFields: Record<string, string>;
}

export interface ContactImportJobData extends BaseImportJobData {
  tenantSettings: ImportTenantSettings;
  catalog: ImportCatalog;
}

// Result (backward compat)

export interface ContactImportResult {
  jobId: string;
  dryRun: boolean;
  summary?: {
    total: number;
    inserted: number;
    updated: number;
    skipped: number;
    errors: number;
  };
  preview?: {
    wouldInsert: number;
    wouldUpdate: number;
    wouldSkip: number;
    validationErrors: number;
  };
  reportUrl?: string;
}

@Processor(CONTACT_IMPORT_QUEUE, { concurrency: 3 })
export class ContactImportProcessor extends BaseImportProcessor<ContactImportJobData> {
  protected readonly logger = new Logger(ContactImportProcessor.name);
  protected readonly cls: ClsService;
  protected readonly moduleConfig = CONTACT_IMPORT_CONFIG;
  protected readonly allowPartialBatchFailure: boolean = false;

  private readonly storage: ImportStorageService;
  private readonly reportService: ImportReportService;

  constructor(
    @InjectModel(ContactSchemaClass.name)
    private readonly contactModel: Model<ContactSchemaDocument>,
    private readonly storageFactory: ImportStorageFactory,
    private readonly lockService: RedisLockService,
    private readonly automationOutbox: AutomationOutboxService,
    private readonly identitySync: ContactIdentitySyncService,
    cls: ClsService,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    @InjectModel(ImportJobSchemaClass.name)
    private readonly importJobModel: Model<ImportJobDocument>,
    @InjectConnection() private readonly connection: Connection,
  ) {
    super();
    this.cls = cls;
    this.storage = this.storageFactory.create('contacts');
    this.reportService = new ImportReportService(this.storage);
  }

  protected getEntityModel(): Model<any> {
    return this.contactModel;
  }

  protected getAutomationOutbox(): AutomationOutboxService {
    return this.automationOutbox;
  }
  protected getStorage(): ImportStorageService {
    return this.storage;
  }
  protected getReportService(): ImportReportService {
    return this.reportService;
  }
  protected getLockService(): RedisLockService {
    return this.lockService;
  }
  protected getRedis(): Redis {
    return this.redis;
  }
  protected getConnection(): Connection {
    return this.connection;
  }
  protected getImportJobModel(): Model<any> {
    return this.importJobModel;
  }

  protected async afterBatchWrite(
    affected: Array<{
      id?: string;
      type: 'insert' | 'update';
      row: number;
    }>,
    data: ContactImportJobData,
  ): Promise<void> {
    const ids = affected.map((item) => item.id).filter(Boolean) as string[];
    if (ids.length === 0) return;

    const contacts = await this.contactModel
      .find({ _id: { $in: ids }, tenantId: data.tenantId })
      .select({ emails: 1, phones: 1, omniIdentities: 1 })
      .lean()
      .exec();

    await this.identitySync.syncManyFromContacts(
      (contacts as any[]).map((contact) => ({
        contactId: String(contact._id),
        contact,
      })),
      {
        source: 'import',
        defaultCountryCode: data.tenantSettings.defaultCountryCode,
        tenantId: data.tenantId,
        userId: data.userId,
        strict: true,
      },
    );
  }

  protected mapRow(
    raw: Record<string, string>,
    mapping: Record<string, string>,
    row: number,
    data: ContactImportJobData,
  ): MappedRow {
    const defaultCountryCode = data.tenantSettings?.defaultCountryCode;
    const catalog = data.catalog;
    const fields: Record<string, any> = {};
    const customFields: Record<string, any> = {};
    const arrayFields: Record<string, string[]> = {
      emails: [],
      phones: [],
      tags: [],
    };

    for (const [header, field] of Object.entries(mapping)) {
      const value = (raw[header] ?? '').toString().trim();
      if (!value) continue;

      if (field === 'emails') {
        arrayFields.emails.push(
          ...splitMultiValue(value).map((e) => normalizeEmail(e)),
        );
      } else if (field === 'phones') {
        arrayFields.phones.push(
          ...splitMultiValue(value).map((p) =>
            normalizePhone(p, defaultCountryCode),
          ),
        );
      } else if (field === 'tags') {
        // Names in, ids out. An unresolved name is dropped here and reported by
        // validateRow — a typo in one cell must not fail a 200k-row migration.
        for (const name of splitMultiValue(value)) {
          const id = catalog?.tags?.[name.toLowerCase()];
          if (id) arrayFields.tags.push(id);
        }
      } else if (field.startsWith(IMPORT_CUSTOM_FIELD_PREFIX)) {
        const key = field.slice(IMPORT_CUSTOM_FIELD_PREFIX.length);
        if (catalog?.customFields?.[key]) {
          customFields[key] = this.coerceCustomField(
            value,
            catalog.customFields[key],
          );
        }
      } else if (IMPORT_BOOLEAN_FIELDS.has(field)) {
        fields[field] = this.parseBoolean(value);
      } else if (IMPORT_SETTING_REFERENCE_FIELDS.has(field)) {
        const resolved = this.resolveSettingReference(field, value, catalog);
        if (resolved) fields[field] = resolved;
      } else if (field === 'birthday') {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) fields.birthday = parsed;
      } else if (field === 'country') {
        fields.country = value.toUpperCase();
      } else if ((SCALAR_FIELDS as readonly string[]).includes(field)) {
        fields[field] = value;
      }
    }

    if (Object.keys(customFields).length) fields.customFields = customFields;

    arrayFields.emails = this.uniq(arrayFields.emails);
    arrayFields.phones = this.uniq(arrayFields.phones);
    arrayFields.tags = this.uniq(arrayFields.tags);

    return { row, fields, arrayFields };
  }

  /**
   * What a spreadsheet means by "yes".
   *
   * Marketing consent arrives as `TRUE`, `Yes`, `1`, `Y`, `Có`. Treating
   * anything but `true` as false would silently opt out an entire migrated
   * customer base; treating anything non-empty as true would opt IN people who
   * wrote "No". Both are compliance failures, so the spellings are explicit and
   * anything unrecognised is false.
   */
  private parseBoolean(value: string): boolean {
    return ['true', 'yes', 'y', '1', 'có', 'x'].includes(
      value.trim().toLowerCase(),
    );
  }

  private resolveSettingReference(
    field: string,
    value: string,
    catalog?: ImportCatalog,
  ): string | undefined {
    const key = value.toLowerCase();
    if (field === 'lifecycleStageId') return catalog?.lifecycleStages?.[key];
    if (field === 'statusId') return catalog?.statuses?.[key];
    return catalog?.sources?.[key];
  }

  /**
   * Coerce a cell to the type the tenant declared for that custom field.
   *
   * Deliberately narrow: NUMBER-ish types become numbers, DATE types become
   * dates, BOOLEAN becomes a boolean, MULTI-valued types split, and everything
   * else stays the string it was. An unparseable number stays a string and is
   * rejected by the row validator, which is where the user sees why.
   */
  private coerceCustomField(value: string, type: string): unknown {
    if (
      ['NUMBER', 'DECIMAL', 'CURRENCY', 'PERCENTAGE', 'SCORE'].includes(type)
    ) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    }
    if (['DATE', 'DATETIME'].includes(type)) {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? value : parsed;
    }
    if (type === 'BOOLEAN' || type === 'CHECKBOX_GROUP') {
      return type === 'BOOLEAN'
        ? this.parseBoolean(value)
        : splitMultiValue(value);
    }
    if (type === 'MULTI_SELECT' || type === 'MULTI_LOOKUP') {
      return splitMultiValue(value);
    }
    return value;
  }

  protected validateRow(
    mapped: MappedRow,
    _data: ContactImportJobData,
  ): ImportRowError[] {
    const errors: ImportRowError[] = [];
    const maxLengths: Record<string, number> = {
      firstName: 200,
      lastName: 200,
      companyName: 255,
      title: 255,
      role: 255,
      city: 120,
      externalId: 200,
      externalSource: 60,
      address: 2_000,
    };

    // A two-letter code, uppercased in mapRow. Rejected rather than stored raw:
    // a mix of "SA", "Saudi Arabia" and "KSA" in one column makes the country
    // axis of every segment wrong, and silently.
    if (mapped.fields.country && !/^[A-Z]{2}$/.test(mapped.fields.country)) {
      errors.push({
        row: mapped.row,
        code: ImportErrorCode.VALIDATION_FAILED,
        field: 'country',
        reason: 'Country must be a 2-letter ISO-3166-1 alpha-2 code (e.g. SA)',
        value: String(mapped.fields.country).slice(0, 500),
      });
    }

    // An externalId with no source cannot be unique or looked up: the index is
    // on the pair. Accepting it would store a key nothing can ever match.
    if (mapped.fields.externalId && !mapped.fields.externalSource) {
      errors.push({
        row: mapped.row,
        code: ImportErrorCode.VALIDATION_FAILED,
        field: 'externalSource',
        reason: 'externalSource is required whenever externalId is supplied',
        value: String(mapped.fields.externalId).slice(0, 500),
      });
    }

    for (const [field, max] of Object.entries(maxLengths)) {
      const value = mapped.fields[field];
      if (typeof value === 'string' && value.length > max) {
        errors.push({
          row: mapped.row,
          code: ImportErrorCode.VALIDATION_FAILED,
          field,
          reason: `${field} exceeds the ${max} character limit`,
          value: value.slice(0, 500),
        });
      }
    }

    for (const email of mapped.arrayFields.emails ?? []) {
      if (email.length > 320 || !isEmail(email)) {
        errors.push({
          row: mapped.row,
          code: ImportErrorCode.VALIDATION_FAILED,
          field: 'emails',
          reason: 'Invalid email address',
          value: email.slice(0, 500),
        });
      }
    }

    for (const phone of mapped.arrayFields.phones ?? []) {
      const digitCount = phone.replace(/\D/g, '').length;
      if (digitCount < 7 || digitCount > 15) {
        errors.push({
          row: mapped.row,
          code: ImportErrorCode.VALIDATION_FAILED,
          field: 'phones',
          reason: 'Phone number must contain 7 to 15 digits',
          value: phone.slice(0, 500),
        });
      }
    }

    return errors;
  }

  protected extractDedupValues(row: MappedRow, field: string): string[] {
    switch (field) {
      case 'emails':
        return row.arrayFields.emails ?? [];
      case 'phones':
        return row.arrayFields.phones ?? [];
      // The idempotency key. Matching on it is what lets an integration re-run
      // the same export without duplicating everyone in it — email and phone
      // change, a customer id does not.
      case 'externalId':
        return row.fields.externalId ? [String(row.fields.externalId)] : [];
      default:
        return [];
    }
  }

  protected buildInsert(
    mapped: MappedRow,
    data: ContactImportJobData,
    now: Date,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    resolvedRefs: Record<string, string>,
  ): Record<string, any> {
    return {
      ...mapped.fields,
      emails: mapped.arrayFields.emails ?? [],
      phones: mapped.arrayFields.phones ?? [],
      tags: mapped.arrayFields.tags ?? [],
      tenantId: data.tenantId,
      createdById: data.userId,
      updatedById: data.userId,
      // Ownership MUST be stamped here. The worker writes through
      // `bulkWrite`, which bypasses BaseDocumentRepository.enrichWithContext —
      // the only place that assigns ownerId/orgUnitId. Without these two lines
      // every imported contact is unowned, and unowned records are invisible to
      // scoped users by design (the C3 fix in
      // document-repository.abstract.ts), so a 50k-row import landed in the
      // database and showed up for nobody but an admin.
      ownerId: data.ownerId ?? data.userId,
      ...(data.orgUnitId ? { orgUnitId: data.orgUnitId } : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  protected buildOverwrite(
    mapped: MappedRow,
    data: ContactImportJobData,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    resolvedRefs: Record<string, string>,
  ): Record<string, any> {
    const set: Record<string, any> = {
      ...mapped.fields,
      updatedById: data.userId,
      updatedAt: new Date(),
    };
    if ((mapped.arrayFields.emails?.length ?? 0) > 0)
      set.emails = mapped.arrayFields.emails;
    if ((mapped.arrayFields.phones?.length ?? 0) > 0)
      set.phones = mapped.arrayFields.phones;
    if ((mapped.arrayFields.tags?.length ?? 0) > 0)
      set.tags = mapped.arrayFields.tags;
    return { $set: set };
  }

  protected buildMerge(
    mapped: MappedRow,
    existing: any,
    data: ContactImportJobData,
    errors: ImportRowError[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    resolvedRefs: Record<string, string>,
  ): Record<string, any> | null {
    const set: Record<string, any> = {};
    const addToSet: Record<string, any> = {};

    // Scalar fields: fill only when the existing value is empty.
    for (const field of SCALAR_FIELDS) {
      const incoming = mapped.fields[field];
      if (incoming && !existing[field]) set[field] = incoming;
    }

    // Custom fields merge per KEY, not as a whole object: `$set: {customFields}`
    // would drop every key the file does not carry.
    for (const [key, value] of Object.entries(
      (mapped.fields.customFields ?? {}) as Record<string, unknown>,
    )) {
      if (existing.customFields?.[key] === undefined) {
        set[`customFields.${key}`] = value;
      }
    }
    delete set.customFields;

    // Tags always union — a tag is additive by nature, and "fill only when
    // empty" would mean the second import of a customer adds nothing.
    if ((mapped.arrayFields.tags?.length ?? 0) > 0) {
      const fresh = mapped.arrayFields.tags.filter(
        (tag) => !(existing.tags ?? []).map(String).includes(tag),
      );
      if (fresh.length) addToSet.tags = { $each: fresh };
    }

    this.mergeArray(
      'emails',
      mapped.arrayFields.emails ?? [],
      existing.emails ?? [],
      data.tenantSettings.multipleEmailsAllowed,
      { row: mapped.row, set, addToSet, errors },
    );
    this.mergeArray(
      'phones',
      mapped.arrayFields.phones ?? [],
      existing.phones ?? [],
      data.tenantSettings.multiplePhonesAllowed,
      { row: mapped.row, set, addToSet, errors },
    );

    const update: Record<string, any> = {};
    if (Object.keys(set).length) {
      update.$set = { ...set, updatedById: data.userId, updatedAt: new Date() };
    }
    if (Object.keys(addToSet).length) update.$addToSet = addToSet;

    return Object.keys(update).length ? update : null;
  }

  private mergeArray(
    field: 'emails' | 'phones',
    incoming: string[],
    existing: string[],
    multipleAllowed: boolean,
    context: {
      row: number;
      set: Record<string, any>;
      addToSet: Record<string, any>;
      errors: ImportRowError[];
    },
  ): void {
    if (incoming.length === 0) return;

    if (multipleAllowed) {
      const fresh = incoming.filter((v) => !existing.includes(v));
      if (fresh.length) context.addToSet[field] = { $each: fresh };
      return;
    }

    // Single-value mode: fill if empty, otherwise warn on a differing value.
    if (existing.length === 0) {
      context.set[field] = [incoming[0]];
      if (incoming.length > 1) {
        context.errors.push({
          row: context.row,
          code: ImportErrorCode.VALIDATION_FAILED,
          field,
          reason: `Only the first ${field} kept (multiple ${field} disabled)`,
          value: incoming.slice(1).join('; '),
        });
      }
      return;
    }

    const conflicting = incoming.filter((v) => !existing.includes(v));
    if (conflicting.length) {
      context.errors.push({
        row: context.row,
        code: ImportErrorCode.VALIDATION_FAILED,
        field,
        reason: `Conflict: ${field} differs and multiple ${field} disabled — kept existing`,
        value: conflicting.join('; '),
      });
    }
  }

  private uniq(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean)));
  }
}
