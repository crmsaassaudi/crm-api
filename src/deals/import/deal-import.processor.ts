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
  DealSchemaClass,
  DealSchemaDocument,
} from '../infrastructure/persistence/document/entities/deal.schema';
import {
  DEAL_IMPORT_QUEUE,
  DEAL_IMPORT_BATCH_SIZE,
  DEAL_IMPORT_MAX_FILE_BYTES,
  DEAL_IMPORT_MAPPABLE_FIELDS,
  DEAL_IMPORT_ARRAY_FIELDS,
} from '../deals.constants';
import { buildAutomationEventName } from '../../automation-rules/events/automation-event.payload';

// ── Module config ──────────────────────────────────────────────────

const DEAL_IMPORT_CONFIG: ImportModuleConfig = {
  module: 'deal',
  displayName: 'Deal',
  mappableFields: DEAL_IMPORT_MAPPABLE_FIELDS,
  requiredFields: ['title'],
  arrayFields: DEAL_IMPORT_ARRAY_FIELDS,
  dedupMatchingFields: ['title', 'externalId'],
  dedupPolicies: ['skip', 'overwrite', 'create_new'],
  referenceFields: [
    {
      entityField: 'stageId',
      collection: 'dealstages',
      lookupFields: ['name', 'apiName'],
      tenantScoped: true,
      required: true,
      // Default stageId will be set via tenantSettings if not mapped.
    },
    {
      entityField: 'sourceId',
      collection: 'dealsources',
      lookupFields: ['name', 'apiName'],
      tenantScoped: true,
      required: false,
    },
    {
      entityField: 'ownerId',
      collection: 'users',
      lookupFields: ['email', 'firstName'],
      tenantScoped: false,
      required: false,
    },
  ],
  batchSize: DEAL_IMPORT_BATCH_SIZE,
  maxFileBytes: DEAL_IMPORT_MAX_FILE_BYTES,
  allowDryRun: true,
  allowAutomations: true,
  completionChannel: 'socket:deal:import:completed',
  queueName: DEAL_IMPORT_QUEUE,
};

const SCALAR_FIELDS = DEAL_IMPORT_MAPPABLE_FIELDS.filter(
  (f) => !DEAL_IMPORT_ARRAY_FIELDS.has(f),
);

// ── Job data ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DealImportJobData extends BaseImportJobData {
  // Deal-specific tenant settings can be added here (e.g. default pipeline).
}

// ── Processor ──────────────────────────────────────────────────────

@Processor(DEAL_IMPORT_QUEUE, { concurrency: 3 })
export class DealImportProcessor extends BaseImportProcessor<DealImportJobData> {
  protected readonly logger = new Logger(DealImportProcessor.name);
  protected readonly cls: ClsService;
  protected readonly moduleConfig = DEAL_IMPORT_CONFIG;

  private readonly storage: ImportStorageService;
  private readonly reportService: ImportReportService;

  constructor(
    @InjectModel(DealSchemaClass.name)
    private readonly dealModel: Model<DealSchemaDocument>,
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
    this.storage = this.storageFactory.create('deals');
    this.reportService = new ImportReportService(this.storage);
  }

  protected getEntityModel(): Model<any> {
    return this.dealModel;
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
    const arrayFields: Record<string, string[]> = { tags: [] };

    for (const [header, field] of Object.entries(mapping)) {
      const value = (raw[header] ?? '').toString().trim();
      if (!value) continue;

      if (field === 'tags') {
        arrayFields.tags.push(...this.splitMulti(value));
      } else if (field === 'value' || field === 'probability') {
        const num = Number(value);
        if (!isNaN(num)) fields[field] = num;
      } else if (field === 'closeDate') {
        const date = new Date(value);
        if (!isNaN(date.getTime())) fields[field] = date;
      } else if ((SCALAR_FIELDS as readonly string[]).includes(field)) {
        fields[field] = value;
      }
    }

    // Use title as name if name not mapped.
    if (fields.title && !fields.name) {
      fields.name = fields.title;
    }

    arrayFields.tags = this.uniq(arrayFields.tags);

    return { row, fields, arrayFields };
  }

  protected validateRow(
    _mapped: MappedRow,
    _data: DealImportJobData,
  ): ImportRowError[] {
    return [];
  }

  protected extractDedupValues(
    row: MappedRow,
    field: DedupMatchingField,
  ): string[] {
    switch (field) {
      case 'title':
        return row.fields.title ? [row.fields.title] : [];
      case 'externalId':
        return row.fields.externalId ? [row.fields.externalId] : [];
      default:
        return [];
    }
  }

  protected buildInsert(
    mapped: MappedRow,
    data: DealImportJobData,
    now: Date,
    resolvedRefs: Record<string, string>,
  ): Record<string, any> {
    return {
      ...mapped.fields,
      ...resolvedRefs,
      tags: mapped.arrayFields.tags ?? [],
      pipeline: mapped.fields.pipeline || 'default',
      value: mapped.fields.value ?? 0,
      currency: mapped.fields.currency || 'USD',
      tenantId: data.tenantId,
      createdById: data.userId,
      updatedById: data.userId,
      createdAt: now,
      updatedAt: now,
    };
  }

  protected buildOverwrite(
    mapped: MappedRow,
    data: DealImportJobData,
    resolvedRefs: Record<string, string>,
  ): Record<string, any> {
    const set: Record<string, any> = {
      ...mapped.fields,
      ...resolvedRefs,
      updatedById: data.userId,
      updatedAt: new Date(),
    };
    if ((mapped.arrayFields.tags?.length ?? 0) > 0)
      set.tags = mapped.arrayFields.tags;
    return { $set: set };
  }

  protected buildMerge(
    mapped: MappedRow,
    existing: any,
    data: DealImportJobData,
    _errors: ImportRowError[],
    resolvedRefs: Record<string, string>,
  ): Record<string, any> | null {
    // Deals don't support merge (transactional object).
    // This should never be called because merge is not in dedupPolicies,
    // but implement as a safety net: treat as overwrite.
    return this.buildOverwrite(mapped, data, resolvedRefs);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  protected async afterBatchWrite(
    affected: Array<{ id?: string; type: 'insert' | 'update'; row: number }>,
    data: DealImportJobData,
  ): Promise<void> {
    for (const a of affected) {
      const event = a.type === 'insert' ? 'record_created' : 'field_updated';
      this.eventEmitter.emit(buildAutomationEventName(event, 'Deal'), {
        tenantId: data.tenantId,
        event,
        object: 'Deal',
        recordId: a.id,
        data: {},
        automationDepth: 0,
      });
    }
  }

  private splitMulti(value: string): string[] {
    return value
      .split(/[,;]/)
      .map((v) => v.trim())
      .filter(Boolean);
  }

  private uniq(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean)));
  }
}
