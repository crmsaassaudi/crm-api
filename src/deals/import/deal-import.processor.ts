import { Processor } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
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
  ImportJobSchemaClass,
  ImportJobDocument,
} from '../../common/import';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { RedisLockService } from '../../redis/redis-lock.service';
import { TagsService } from '../../tags/tags.service';
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
import { AutomationOutboxService } from '../../automation-rules/events/automation-outbox.service';

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
      // `deal_stages`, the collection the schema actually declares. The lookup
      // named `dealstages`, which exists nowhere, so every stage name in every
      // import file resolved to nothing — and the field was `required`, so a
      // file with a stage column failed wholesale.
      entityField: 'stageId',
      collection: 'deal_stages',
      lookupFields: ['label', 'apiName'],
      tenantScoped: true,
      // Not required: an unmapped stage falls back to the tenant's default,
      // resolved in request context by DealsService.startImport.
      required: false,
    },
    {
      entityField: 'sourceId',
      collection: 'deal_sources',
      lookupFields: ['name'],
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

// Job data

export interface DealImportJobData extends BaseImportJobData {
  /**
   * Where rows land when the file names no stage.
   *
   * Resolved by `DealsService.startImport` while a request context still exists:
   * the worker has no CLS tenant, so it cannot look the tenant's default
   * pipeline up for itself.
   */
  defaultPipelineId: string;
  defaultStageId: string;
}

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
    private readonly automationOutbox: AutomationOutboxService,
    cls: ClsService,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    @InjectModel(ImportJobSchemaClass.name)
    private readonly importJobModel: Model<ImportJobDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly tagsService: TagsService,
  ) {
    super();
    this.cls = cls;
    this.storage = this.storageFactory.create('deals');
    this.reportService = new ImportReportService(this.storage);
  }

  protected getEntityModel(): Model<any> {
    return this.dealModel;
  }

  /**
   * A stage label is only a candidate if it belongs to the pipeline this import
   * targets — the same label commonly exists in several pipelines, and matching
   * the wrong one files the deal under a stage its own pipeline does not
   * contain, which the board cannot render.
   */
  protected referenceScopeFilters(
    data: DealImportJobData,
  ): Record<string, Record<string, unknown>> {
    return {
      stageId: { pipelineId: new Types.ObjectId(data.defaultPipelineId) },
    };
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

  // Row mapping

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

      this.mapSingleField(field, value, fields, arrayFields);
    }

    // `name` mirrors `title` for the generic related-record display.
    if (fields.title) fields.name = fields.title;

    arrayFields.tags = this.uniq(arrayFields.tags);

    return { row, fields, arrayFields };
  }

  private mapSingleField(
    field: string,
    value: string,
    fields: Record<string, any>,
    arrayFields: Record<string, string[]>,
  ): void {
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

  protected validateRow(
    _mapped: MappedRow,
    _data: DealImportJobData,
  ): ImportRowError[] {
    return [];
  }

  /**
   * Batch-wide resolution of raw "tags" CSV names → catalog Tag ids.
   * Collects every unique name across the whole batch and resolves them in
   * a single call, so a name repeated across many rows only creates (or
   * looks up) one catalog Tag instead of racing per row.
   */
  protected async beforeBuildOps(
    rows: MappedRow[],
    _data: DealImportJobData,
  ): Promise<void> {
    const names = new Set<string>();
    for (const row of rows) {
      for (const name of row.arrayFields.tags ?? []) names.add(name);
    }
    if (names.size === 0) return;

    const nameToId = await this.tagsService.resolveOrCreateByNames('Deal', [
      ...names,
    ]);

    for (const row of rows) {
      const tags = row.arrayFields.tags;
      if (!tags?.length) continue;
      row.arrayFields.tags = this.uniq(
        tags
          .map((name) => nameToId.get(name))
          .filter((id): id is string => !!id),
      );
    }
  }

  protected extractDedupValues(row: MappedRow, field: string): string[] {
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
    const stageId = resolvedRefs.stageId ?? data.defaultStageId;
    return {
      ...mapped.fields,
      ...resolvedRefs,
      tags: mapped.arrayFields.tags ?? [],
      pipelineId: data.defaultPipelineId,
      stageId,
      value: mapped.fields.value ?? 0,
      currency: (mapped.fields.currency || 'USD').toUpperCase(),
      stageEnteredAt: now,
      lastActivityAt: now,
      stageHistory: [
        {
          fromStageId: null,
          toStageId: stageId,
          changedAt: now,
          changedById: data.userId,
          durationMs: null,
        },
      ],
      tenantId: data.tenantId,
      ownerId: resolvedRefs.ownerId ?? data.userId,
      ownerAssignedExplicitly: Boolean(resolvedRefs.ownerId),
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
