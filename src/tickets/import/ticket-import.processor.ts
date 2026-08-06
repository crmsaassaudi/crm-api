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
} from '../../common/import';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { RedisLockService } from '../../redis/redis-lock.service';
import { TagsService } from '../../tags/tags.service';
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
import { AutomationOutboxService } from '../../automation-rules/events/automation-outbox.service';
import { COLLECTIONS } from '../../common/persistence/collections';
import { TicketNumberService } from '../ticket-number.service';

const TICKET_IMPORT_CONFIG: ImportModuleConfig = {
  module: 'ticket',
  displayName: 'Ticket',
  mappableFields: TICKET_IMPORT_MAPPABLE_FIELDS,
  requiredFields: ['subject'],
  arrayFields: TICKET_IMPORT_ARRAY_FIELDS,
  // `ticketNumber` is the ticket's natural key and is unique per tenant, so it
  // is the only thing a re-import can idempotently match on. The previous
  // config matched on `externalId` and `ticketCode` — neither of which is a
  // ticket field nor a mappable column — so `skip` and `overwrite` could never
  // match anything and every import behaved as create-only.
  dedupMatchingFields: ['ticketNumber'],
  dedupPolicies: ['skip', 'overwrite', 'create_new'],
  referenceFields: [
    // Names come from COLLECTIONS, not from string literals: these are raw
    // driver reads, so a misspelling resolves to an empty cache rather than an
    // error. See common/persistence/collections.ts.
    {
      entityField: 'typeId',
      collection: COLLECTIONS.ticketTypes,
      lookupFields: ['name', 'apiName'],
      tenantScoped: true,
      required: true,
    },
    {
      entityField: 'statusId',
      collection: COLLECTIONS.ticketStatuses,
      lookupFields: ['label', 'apiName'],
      tenantScoped: true,
      required: true,
    },
    {
      entityField: 'sourceId',
      collection: COLLECTIONS.ticketSources,
      lookupFields: ['name', 'apiName'],
      tenantScoped: true,
      required: false,
    },
    {
      entityField: 'ownerId',
      collection: COLLECTIONS.users,
      lookupFields: ['email', 'firstName'],
      tenantScoped: false,
      required: false,
    },
    {
      entityField: 'groupId',
      collection: COLLECTIONS.groups,
      lookupFields: ['name'],
      tenantScoped: true,
      required: false,
    },
    // A ticket with no customer is not a support case. `contactId` was not
    // mappable at all, so every imported ticket landed unattached.
    {
      entityField: 'contactId',
      collection: COLLECTIONS.contacts,
      lookupFields: ['emails', 'phones', 'externalId'],
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

// Job data

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TicketImportJobData extends BaseImportJobData {
  // Ticket-specific tenant settings can be added here.
}

@Processor(TICKET_IMPORT_QUEUE, { concurrency: 3 })
export class TicketImportProcessor extends BaseImportProcessor<TicketImportJobData> {
  protected readonly logger = new Logger(TicketImportProcessor.name);
  protected readonly cls: ClsService;
  protected readonly moduleConfig = TICKET_IMPORT_CONFIG;

  private readonly storage: ImportStorageService;
  private readonly reportService: ImportReportService;
  /** Ticket numbers reserved for the current batch, keyed by row number. */
  private readonly reservedNumbers = new Map<number, string>();

  constructor(
    @InjectModel(TicketSchemaClass.name)
    private readonly ticketModel: Model<TicketSchemaDocument>,
    private readonly storageFactory: ImportStorageFactory,
    private readonly lockService: RedisLockService,
    private readonly automationOutbox: AutomationOutboxService,
    cls: ClsService,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    @InjectModel(ImportJobSchemaClass.name)
    private readonly importJobModel: Model<ImportJobDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly tagsService: TagsService,
    private readonly ticketNumbers: TicketNumberService,
  ) {
    super();
    this.cls = cls;
    this.storage = this.storageFactory.create('tickets');
    this.reportService = new ImportReportService(this.storage);
  }

  protected getEntityModel(): Model<any> {
    return this.ticketModel;
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
    _data: TicketImportJobData,
  ): ImportRowError[] {
    const errors: ImportRowError[] = [];
    const subject = String(mapped.fields.subject ?? '').trim();
    if (!subject) {
      errors.push({
        row: mapped.row,
        field: 'subject',
        code: ImportErrorCode.REQUIRED_FIELD_MISSING,
        reason: 'subject is required',
      });
    } else if (subject.length > 500) {
      errors.push({
        row: mapped.row,
        field: 'subject',
        code: ImportErrorCode.VALIDATION_FAILED,
        reason: 'subject must not exceed 500 characters',
      });
    }
    if (String(mapped.fields.description ?? '').length > 50_000) {
      errors.push({
        row: mapped.row,
        field: 'description',
        code: ImportErrorCode.VALIDATION_FAILED,
        reason: 'description must not exceed 50000 characters',
      });
    }
    if ((mapped.arrayFields.tags?.length ?? 0) > 100) {
      errors.push({
        row: mapped.row,
        field: 'tags',
        code: ImportErrorCode.VALIDATION_FAILED,
        reason: 'tags must not contain more than 100 values',
      });
    }
    return errors;
  }

  /**
   * Per-batch prep: resolve tag names to catalog ids, and reserve the batch's
   * ticket numbers.
   *
   * Both are batch-wide on purpose. A tag name repeated across many rows
   * resolves once instead of racing per row, and the numbers come from one
   * atomic counter increment instead of one per inserted ticket.
   */
  protected async beforeBuildOps(
    rows: MappedRow[],
    data: TicketImportJobData,
  ): Promise<void> {
    await this.resolveTagNames(rows);

    const needNumbers = rows.filter((row) => !row.fields.ticketNumber);
    this.reservedNumbers.clear();
    if (needNumbers.length > 0) {
      const numbers = await this.ticketNumbers.reserve(
        data.tenantId,
        needNumbers.length,
      );
      needNumbers.forEach((row, index) =>
        this.reservedNumbers.set(row.row, numbers[index]),
      );
    }
  }

  private async resolveTagNames(rows: MappedRow[]): Promise<void> {
    const names = new Set<string>();
    for (const row of rows) {
      for (const name of row.arrayFields.tags ?? []) names.add(name);
    }
    if (names.size === 0) return;

    const nameToId = await this.tagsService.resolveOrCreateByNames('Ticket', [
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
    if (field !== 'ticketNumber') return [];
    const value = String(row.fields.ticketNumber ?? '').trim();
    return value ? [value] : [];
  }

  protected buildInsert(
    mapped: MappedRow,
    data: TicketImportJobData,
    now: Date,
    resolvedRefs: Record<string, string>,
  ): Record<string, any> {
    // A file that carries its own numbers (a migration off another helpdesk)
    // keeps them; everything else draws from the same per-tenant counter the
    // API uses, reserved for the whole batch in `beforeBuildOps`.
    const ticketNumber =
      String(mapped.fields.ticketNumber ?? '').trim() ||
      this.reservedNumbers.get(mapped.row);

    return {
      ...mapped.fields,
      ...resolvedRefs,
      ticketNumber,
      tags: mapped.arrayFields.tags ?? [],
      priority: mapped.fields.priority || 'MEDIUM',
      isSlaBreached: false,
      reopenCount: 0,
      tenantId: data.tenantId,
      createdById: data.userId,
      updatedById: data.userId,
      ownerAssignedExplicitly: Boolean(resolvedRefs.ownerId),
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
