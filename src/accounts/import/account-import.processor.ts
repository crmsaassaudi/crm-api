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
  DedupMatchingField,
  ImportJobSchemaClass,
  ImportJobDocument,
} from '../../common/import';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { RedisLockService } from '../../redis/redis-lock.service';
import {
  AccountSchemaClass,
  AccountSchemaDocument,
} from '../infrastructure/persistence/document/entities/account.schema';
import {
  ACCOUNT_IMPORT_QUEUE,
  ACCOUNT_IMPORT_BATCH_SIZE,
  ACCOUNT_IMPORT_MAX_FILE_BYTES,
  ACCOUNT_IMPORT_MAPPABLE_FIELDS,
  ACCOUNT_IMPORT_ARRAY_FIELDS,
} from '../accounts.constants';
import { buildAutomationEventName } from '../../automation-rules/events/automation-event.payload';

// ── Module config ──────────────────────────────────────────────────

const ACCOUNT_IMPORT_CONFIG: ImportModuleConfig = {
  module: 'account',
  displayName: 'Account',
  mappableFields: ACCOUNT_IMPORT_MAPPABLE_FIELDS,
  requiredFields: ['name'],
  arrayFields: ACCOUNT_IMPORT_ARRAY_FIELDS,
  dedupMatchingFields: ['name', 'emails', 'taxId'],
  dedupPolicies: ['skip', 'overwrite', 'merge'],
  referenceFields: [
    // statusId: resolve by label or apiName
    {
      entityField: 'statusId',
      collection: 'accountstatuses',
      lookupFields: ['label', 'apiName'],
      tenantScoped: true,
      required: false,
    },
    // typeId: resolve by name or apiName
    {
      entityField: 'typeId',
      collection: 'accounttypes',
      lookupFields: ['name', 'apiName'],
      tenantScoped: true,
      required: false,
    },
    // ownerId: resolve by email or name
    {
      entityField: 'ownerId',
      collection: 'users',
      lookupFields: ['email', 'firstName'],
      tenantScoped: false,
      required: false,
    },
  ],
  batchSize: ACCOUNT_IMPORT_BATCH_SIZE,
  maxFileBytes: ACCOUNT_IMPORT_MAX_FILE_BYTES,
  allowDryRun: true,
  allowAutomations: true,
  completionChannel: 'socket:account:import:completed',
  queueName: ACCOUNT_IMPORT_QUEUE,
};

const SCALAR_FIELDS = ACCOUNT_IMPORT_MAPPABLE_FIELDS.filter(
  (f) => !ACCOUNT_IMPORT_ARRAY_FIELDS.has(f),
);

// ── Job data ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AccountImportJobData extends BaseImportJobData {
  // Account-specific tenant settings can be added here in the future.
}

// ── Processor ──────────────────────────────────────────────────────

@Processor(ACCOUNT_IMPORT_QUEUE, { concurrency: 3 })
export class AccountImportProcessor extends BaseImportProcessor<AccountImportJobData> {
  protected readonly logger = new Logger(AccountImportProcessor.name);
  protected readonly cls: ClsService;
  protected readonly moduleConfig = ACCOUNT_IMPORT_CONFIG;

  private readonly storage: ImportStorageService;
  private readonly reportService: ImportReportService;

  constructor(
    @InjectModel(AccountSchemaClass.name)
    private readonly accountModel: Model<AccountSchemaDocument>,
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
    this.storage = this.storageFactory.create('accounts');
    this.reportService = new ImportReportService(this.storage);
  }

  // ── Abstract method implementations ──

  protected getEntityModel(): Model<any> {
    return this.accountModel;
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
      tags: [],
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
      } else if (field === 'tags') {
        arrayFields.tags.push(...this.splitMulti(value));
      } else if (field === 'annualRevenue' || field === 'numberOfEmployees') {
        const num = Number(value);
        if (!isNaN(num)) fields[field] = num;
      } else if ((SCALAR_FIELDS as readonly string[]).includes(field)) {
        fields[field] = value;
      }
    }

    // Deduplicate array values
    arrayFields.emails = this.uniq(arrayFields.emails);
    arrayFields.phones = this.uniq(arrayFields.phones);
    arrayFields.tags = this.uniq(arrayFields.tags);

    return { row, fields, arrayFields };
  }

  // ── Row validation ──

  protected validateRow(
    _mapped: MappedRow,
    _data: AccountImportJobData,
  ): ImportRowError[] {
    // Account has minimal validation beyond required fields.
    // Email/phone format validation could be added here.
    return [];
  }

  // ── Dedup value extraction ──

  protected extractDedupValues(
    row: MappedRow,
    field: DedupMatchingField,
  ): string[] {
    switch (field) {
      case 'name':
        return row.fields.name ? [row.fields.name] : [];
      case 'emails':
        return row.arrayFields.emails ?? [];
      case 'taxId':
        return row.fields.taxId ? [row.fields.taxId] : [];
      default:
        return [];
    }
  }

  // ── Build insert document ──

  protected buildInsert(
    mapped: MappedRow,
    data: AccountImportJobData,
    now: Date,
    resolvedRefs: Record<string, string>,
  ): Record<string, any> {
    return {
      ...mapped.fields,
      ...resolvedRefs,
      emails: mapped.arrayFields.emails ?? [],
      phones: mapped.arrayFields.phones ?? [],
      tags: mapped.arrayFields.tags ?? [],
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
    data: AccountImportJobData,
    resolvedRefs: Record<string, string>,
  ): Record<string, any> {
    const set: Record<string, any> = {
      ...mapped.fields,
      ...resolvedRefs,
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

  // ── Build merge update ──

  protected buildMerge(
    mapped: MappedRow,
    existing: any,
    data: AccountImportJobData,
    _errors: ImportRowError[],
    resolvedRefs: Record<string, string>,
  ): Record<string, any> | null {
    const set: Record<string, any> = {};
    const addToSet: Record<string, any> = {};

    // Scalar fields: fill only when existing value is empty.
    for (const field of SCALAR_FIELDS) {
      const incoming = mapped.fields[field];
      if (incoming && !existing[field]) set[field] = incoming;
    }

    // Reference fields: fill only when existing value is empty.
    for (const [key, value] of Object.entries(resolvedRefs)) {
      if (!existing[key]) set[key] = value;
    }

    // Array fields: append new values.
    for (const field of ['emails', 'phones', 'tags']) {
      const incoming = mapped.arrayFields[field] ?? [];
      const existingArr = existing[field] ?? [];
      const fresh = incoming.filter((v: string) => !existingArr.includes(v));
      if (fresh.length) addToSet[field] = { $each: fresh };
    }

    const update: Record<string, any> = {};
    if (Object.keys(set).length) {
      update.$set = {
        ...set,
        updatedById: data.userId,
        updatedAt: new Date(),
      };
    }
    if (Object.keys(addToSet).length) update.$addToSet = addToSet;

    return Object.keys(update).length ? update : null;
  }

  // ── Post-write hook: automation events ──

  // eslint-disable-next-line @typescript-eslint/require-await
  protected async afterBatchWrite(
    affected: Array<{ id?: string; type: 'insert' | 'update'; row: number }>,
    data: AccountImportJobData,
  ): Promise<void> {
    for (const a of affected) {
      const event = a.type === 'insert' ? 'record_created' : 'field_updated';
      this.eventEmitter.emit(buildAutomationEventName(event, 'Account'), {
        tenantId: data.tenantId,
        event,
        object: 'Account',
        recordId: a.id,
        data: {},
        automationDepth: 0,
      });
    }
  }

  // ── Helpers ──

  private splitMulti(value: string): string[] {
    return value
      .split(/[,;]/)
      .map((v) => v.trim())
      .filter(Boolean);
  }

  private normalizePhone(value: string): string {
    // Strip everything except digits — no '+' prefix
    return value.replace(/[^0-9]/g, '');
  }

  private uniq(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean)));
  }
}
