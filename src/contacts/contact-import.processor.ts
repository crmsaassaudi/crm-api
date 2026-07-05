import { Processor } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
} from './contacts.constants';
import { buildAutomationEventName } from '../automation-rules/events/automation-event.payload';

// ── Module config ──────────────────────────────────────────────────

const CONTACT_IMPORT_CONFIG: ImportModuleConfig = {
  module: 'contact',
  displayName: 'Contact',
  mappableFields: IMPORT_MAPPABLE_FIELDS,
  requiredFields: ['firstName', 'lastName'],
  arrayFields: IMPORT_ARRAY_FIELDS,
  dedupMatchingFields: ['emails', 'phones'],
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

// ── Tenant settings (snapshotted at enqueue time) ──

export interface ImportTenantSettings {
  uniqueEmail: boolean;
  uniquePhone: boolean;
  multipleEmailsAllowed: boolean;
  multiplePhonesAllowed: boolean;
}

// ── Job data ──────────────────────────────────────────────────────

export interface ContactImportJobData extends BaseImportJobData {
  tenantSettings: ImportTenantSettings;
}

// ── Result (backward compat) ──

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

// ── Processor ──────────────────────────────────────────────────────

@Processor(CONTACT_IMPORT_QUEUE, { concurrency: 3 })
export class ContactImportProcessor extends BaseImportProcessor<ContactImportJobData> {
  protected readonly logger = new Logger(ContactImportProcessor.name);
  protected readonly cls: ClsService;
  protected readonly moduleConfig = CONTACT_IMPORT_CONFIG;

  private readonly storage: ImportStorageService;
  private readonly reportService: ImportReportService;

  constructor(
    @InjectModel(ContactSchemaClass.name)
    private readonly contactModel: Model<ContactSchemaDocument>,
    private readonly storageFactory: ImportStorageFactory,
    private readonly lockService: RedisLockService,
    private readonly eventEmitter: EventEmitter2,
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
  protected getStorage(): ImportStorageService {
    return this.storage;
  }
  protected getReportService(): ImportReportService {
    return this.reportService;
  }
  protected getLockService(): RedisLockService {
    return this.lockService;
  }
  protected getEventEmitter(): EventEmitter2 {
    return this.eventEmitter;
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

  // ── Row mapping ──

  protected mapRow(
    raw: Record<string, string>,
    mapping: Record<string, string>,
    row: number,
  ): MappedRow {
    const fields: Record<string, any> = {};
    const arrayFields: Record<string, string[]> = {
      emails: [],
      phones: [],
    };

    for (const [header, field] of Object.entries(mapping)) {
      const value = (raw[header] ?? '').toString().trim();
      if (!value) continue;
      if (field === 'emails') {
        arrayFields.emails.push(
          ...this.splitMulti(value).map((e) => e.toLowerCase()),
        );
      } else if (field === 'phones') {
        arrayFields.phones.push(
          ...this.splitMulti(value).map((p) => this.normalizePhone(p)),
        );
      } else if ((SCALAR_FIELDS as readonly string[]).includes(field)) {
        fields[field] = value;
      }
    }

    arrayFields.emails = this.uniq(arrayFields.emails);
    arrayFields.phones = this.uniq(arrayFields.phones);

    return { row, fields, arrayFields };
  }

  // ── Row validation ──

  protected validateRow(
    _mapped: MappedRow,
    _data: ContactImportJobData,
  ): ImportRowError[] {
    return [];
  }

  // ── Dedup value extraction ──

  protected extractDedupValues(row: MappedRow, field: string): string[] {
    switch (field) {
      case 'emails':
        return row.arrayFields.emails ?? [];
      case 'phones':
        return row.arrayFields.phones ?? [];
      default:
        return [];
    }
  }

  // ── Build insert document ──

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
      tenantId: data.tenantId,
      createdById: data.userId,
      updatedById: data.userId,
      createdAt: now,
      updatedAt: now,
    };
  }

  // ── Build overwrite update ──

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
    return { $set: set };
  }

  // ── Build merge update ──

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

  // ── Post-write hook: automation events ──

  // eslint-disable-next-line @typescript-eslint/require-await
  protected async afterBatchWrite(
    affected: Array<{ id?: string; type: 'insert' | 'update'; row: number }>,
    data: ContactImportJobData,
  ): Promise<void> {
    for (const a of affected) {
      const event = a.type === 'insert' ? 'record_created' : 'field_updated';
      this.eventEmitter.emit(buildAutomationEventName(event, 'Contact'), {
        tenantId: data.tenantId,
        event,
        object: 'Contact',
        recordId: a.id,
        data: {},
        automationDepth: 0,
      });
    }
  }

  // ── Contact-specific helpers ──

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

  private splitMulti(value: string): string[] {
    return value
      .split(/[,;]/)
      .map((v) => v.trim())
      .filter(Boolean);
  }

  private normalizePhone(value: string): string {
    // Strip everything except digits — no '+' prefix
    return value.replace(/\D/g, '');
  }

  private uniq(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean)));
  }
}
