import { Processor } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Redis from 'ioredis';
import { ulid } from 'ulid';

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
  TicketSchemaClass,
  TicketSchemaDocument,
} from '../infrastructure/persistence/document/entities/ticket.schema';
import {
  TICKET_IMPORT_QUEUE,
  TICKET_IMPORT_BATCH_SIZE,
  TICKET_IMPORT_MAX_FILE_BYTES,
  TICKET_IMPORT_MAPPABLE_FIELDS,
  TICKET_IMPORT_ARRAY_FIELDS,
} from '../tickets.constants';
import { buildAutomationEventName } from '../../automation-rules/events/automation-event.payload';

// ── Module config ──────────────────────────────────────────────────

const TICKET_IMPORT_CONFIG: ImportModuleConfig = {
  module: 'ticket',
  displayName: 'Ticket',
  mappableFields: TICKET_IMPORT_MAPPABLE_FIELDS,
  requiredFields: ['subject'],
  arrayFields: TICKET_IMPORT_ARRAY_FIELDS,
  dedupMatchingFields: ['externalId', 'ticketCode'],
  dedupPolicies: ['skip', 'overwrite', 'create_new'],
  referenceFields: [
    {
      entityField: 'typeId',
      collection: 'tickettypes',
      lookupFields: ['name', 'apiName'],
      tenantScoped: true,
      required: true,
    },
    {
      entityField: 'statusId',
      collection: 'ticketstatuses',
      lookupFields: ['name', 'apiName'],
      tenantScoped: true,
      required: true,
    },
    {
      entityField: 'sourceId',
      collection: 'ticketsources',
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
    {
      entityField: 'groupId',
      collection: 'groups',
      lookupFields: ['name'],
      tenantScoped: true,
      required: false,
    },
  ],
  batchSize: TICKET_IMPORT_BATCH_SIZE,
  maxFileBytes: TICKET_IMPORT_MAX_FILE_BYTES,
  allowDryRun: true,
  allowAutomations: true,
  completionChannel: 'socket:ticket:import:completed',
  queueName: TICKET_IMPORT_QUEUE,
};

const SCALAR_FIELDS = TICKET_IMPORT_MAPPABLE_FIELDS.filter(
  (f) => !TICKET_IMPORT_ARRAY_FIELDS.has(f),
);

// ── Job data ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TicketImportJobData extends BaseImportJobData {
  // Ticket-specific tenant settings can be added here.
}

// ── Processor ──────────────────────────────────────────────────────

@Processor(TICKET_IMPORT_QUEUE, { concurrency: 3 })
export class TicketImportProcessor extends BaseImportProcessor<TicketImportJobData> {
  protected readonly logger = new Logger(TicketImportProcessor.name);
  protected readonly cls: ClsService;
  protected readonly moduleConfig = TICKET_IMPORT_CONFIG;

  private readonly storage: ImportStorageService;
  private readonly reportService: ImportReportService;

  constructor(
    @InjectModel(TicketSchemaClass.name)
    private readonly ticketModel: Model<TicketSchemaDocument>,
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
    this.storage = this.storageFactory.create('tickets');
    this.reportService = new ImportReportService(this.storage);
  }

  protected getEntityModel(): Model<any> {
    return this.ticketModel;
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
      } else if ((SCALAR_FIELDS as readonly string[]).includes(field)) {
        fields[field] = value;
      }
    }

    // Normalize priority.
    if (fields.priority) {
      fields.priority = fields.priority.toUpperCase();
      if (!['URGENT', 'HIGH', 'MEDIUM', 'LOW'].includes(fields.priority)) {
        fields.priority = 'MEDIUM';
      }
    }

    arrayFields.tags = this.uniq(arrayFields.tags);

    return { row, fields, arrayFields };
  }

  protected validateRow(
    mapped: MappedRow,
    data: TicketImportJobData,
  ): ImportRowError[] {
    return [];
  }

  protected extractDedupValues(
    row: MappedRow,
    field: DedupMatchingField,
  ): string[] {
    switch (field) {
      case 'externalId':
        return row.fields.externalId ? [row.fields.externalId] : [];
      case 'ticketCode':
        return row.fields.ticketCode ? [row.fields.ticketCode] : [];
      default:
        return [];
    }
  }

  protected buildInsert(
    mapped: MappedRow,
    data: TicketImportJobData,
    now: Date,
    resolvedRefs: Record<string, string>,
  ): Record<string, any> {
    // Auto-generate ticket number using ULID for uniqueness.
    const ticketNumber = `TKT-${ulid().slice(-8)}`;

    return {
      ...mapped.fields,
      ...resolvedRefs,
      ticketNumber,
      tags: mapped.arrayFields.tags ?? [],
      priority: mapped.fields.priority || 'MEDIUM',
      isSlaBreached: false,
      tenantId: data.tenantId,
      createdById: data.userId,
      updatedById: data.userId,
      createdAt: now,
      updatedAt: now,
    };
  }

  protected buildOverwrite(
    mapped: MappedRow,
    data: TicketImportJobData,
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
    _existing: any,
    data: TicketImportJobData,
    _errors: ImportRowError[],
    resolvedRefs: Record<string, string>,
  ): Record<string, any> | null {
    // Tickets don't support merge — treat as overwrite.
    return this.buildOverwrite(mapped, data, resolvedRefs);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  protected async afterBatchWrite(
    affected: Array<{ id?: string; type: 'insert' | 'update'; row: number }>,
    data: TicketImportJobData,
  ): Promise<void> {
    for (const a of affected) {
      const event = a.type === 'insert' ? 'record_created' : 'field_updated';
      this.eventEmitter.emit(buildAutomationEventName(event, 'Ticket'), {
        tenantId: data.tenantId,
        event,
        object: 'Ticket',
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
