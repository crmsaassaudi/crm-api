import { Processor } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import Redis from 'ioredis';

import {
  BaseExportProcessor,
  BaseExportJobData,
  ExportColumn,
  ExportCursor,
  ExportModuleConfig,
  ExportQueryOptions,
  ExportStorageService,
  ExportStorageFactory,
  ExportMaskingService,
  ExportJobSchemaClass,
  ExportJobDocument,
  EXPORT_WORKER_OPTIONS,
  DEFAULT_EXPORT_HARD_CAP,
} from '../../common/export';
import { TICKET_EXPORT_QUEUE } from '../tickets.constants';
import { TicketRepository } from '../infrastructure/persistence/document/repositories/ticket.repository';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { RedisLockService } from '../../redis/redis-lock.service';
import {
  UserSchemaClass,
} from '../../users/infrastructure/persistence/document/entities/user.schema';
import {
  TicketStatusSchemaClass,
} from '../../ticket-settings/entities/ticket-status.schema';
import {
  TicketTypeSchemaClass,
} from '../../ticket-settings/entities/ticket-type.schema';
import {
  TicketSourceSchemaClass,
} from '../../ticket-settings/entities/ticket-source.schema';
import {
  GroupSchemaClass,
} from '../../groups/infrastructure/persistence/document/entities/group.schema';

// ── Helpers ─────────────────────────────────────────────────────────

const resolve = (map: Map<string, string>, val: unknown): string =>
  map.get(String(val ?? '')) || String(val ?? '');

// ── Columns ─────────────────────────────────────────────────────────

function buildTicketExportColumns(
  userMap: Map<string, string>,
  statusMap: Map<string, string>,
  typeMap: Map<string, string>,
  sourceMap: Map<string, string>,
  groupMap: Map<string, string>,
): ExportColumn[] {
  return [
    { header: 'id', path: 'id' },
    { header: 'subject', path: 'subject' },
    { header: 'priority', path: 'priority' },
    { header: 'channel', path: 'channel' },
    {
      header: 'status',
      path: 'statusId',
      format: (val) => resolve(statusMap, val),
    },
    {
      header: 'type',
      path: 'typeId',
      format: (val) => resolve(typeMap, val),
    },
    {
      header: 'source',
      path: 'sourceId',
      format: (val) => resolve(sourceMap, val),
    },
    {
      header: 'owner',
      path: 'ownerId',
      format: (val) => resolve(userMap, val),
    },
    {
      header: 'group',
      path: 'groupId',
      format: (val) => resolve(groupMap, val),
    },
    { header: 'tags', path: 'tags' },
    { header: 'createdAt', path: 'createdAt' },
  ];
}

const STATIC_COLUMNS: readonly ExportColumn[] = [
  { header: 'id', path: 'id' },
  { header: 'subject', path: 'subject' },
  { header: 'priority', path: 'priority' },
  { header: 'channel', path: 'channel' },
  { header: 'status', path: 'statusId' },
  { header: 'type', path: 'typeId' },
  { header: 'source', path: 'sourceId' },
  { header: 'owner', path: 'ownerId' },
  { header: 'group', path: 'groupId' },
  { header: 'tags', path: 'tags' },
  { header: 'createdAt', path: 'createdAt' },
] as const;

export interface TicketExportJobData extends BaseExportJobData {
  ids?: string[];
  legacyFilters?: Record<string, any>;
}

@Processor(TICKET_EXPORT_QUEUE, EXPORT_WORKER_OPTIONS)
export class TicketExportProcessor extends BaseExportProcessor<TicketExportJobData> {
  protected readonly logger = new Logger(TicketExportProcessor.name);
  protected readonly cls: ClsService;
  private readonly storage: ExportStorageService;

  // ── Per-job lookup maps ───────────────────────────────────────────
  private userMap = new Map<string, string>();
  private statusMap = new Map<string, string>();
  private typeMap = new Map<string, string>();
  private sourceMap = new Map<string, string>();
  private groupMap = new Map<string, string>();
  private resolvedColumns: ExportColumn[] = [];

  constructor(
    private readonly repository: TicketRepository,
    storageFactory: ExportStorageFactory,
    private readonly lockService: RedisLockService,
    private readonly maskingService: ExportMaskingService,
    cls: ClsService,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    @InjectModel(ExportJobSchemaClass.name)
    private readonly exportJobModel: Model<ExportJobDocument>,
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(UserSchemaClass.name)
    private readonly userModel: Model<any>,
    @InjectModel(TicketStatusSchemaClass.name)
    private readonly ticketStatusModel: Model<any>,
    @InjectModel(TicketTypeSchemaClass.name)
    private readonly ticketTypeModel: Model<any>,
    @InjectModel(TicketSourceSchemaClass.name)
    private readonly ticketSourceModel: Model<any>,
    @InjectModel(GroupSchemaClass.name)
    private readonly groupModel: Model<any>,
  ) {
    super();
    this.cls = cls;
    this.storage = storageFactory.create('tickets');
  }

  // ── Lifecycle hook ────────────────────────────────────────────────

  protected async beforeExport(data: TicketExportJobData): Promise<void> {
    await Promise.all([
      this.loadUserMap(data.tenantId),
      this.loadStatusMap(data.tenantId),
      this.loadTypeMap(data.tenantId),
      this.loadSourceMap(data.tenantId),
      this.loadGroupMap(data.tenantId),
    ]);

    this.resolvedColumns = buildTicketExportColumns(
      this.userMap,
      this.statusMap,
      this.typeMap,
      this.sourceMap,
      this.groupMap,
    );
  }

  private async loadUserMap(tenantId: string): Promise<void> {
    this.userMap.clear();
    const users = await this.userModel
      .find(
        { 'tenants.tenantId': tenantId },
        { firstName: 1, lastName: 1, email: 1 },
      )
      .lean()
      .exec();
    for (const u of users as any[]) {
      const name = [u.firstName, u.lastName].filter(Boolean).join(' ');
      this.userMap.set(String(u._id), name || u.email || String(u._id));
    }
  }

  private async loadStatusMap(tenantId: string): Promise<void> {
    this.statusMap.clear();
    const docs = await this.ticketStatusModel
      .find({ tenantId }, { label: 1 })
      .lean()
      .exec();
    for (const d of docs as any[]) {
      this.statusMap.set(String(d._id), d.label);
    }
  }

  private async loadTypeMap(tenantId: string): Promise<void> {
    this.typeMap.clear();
    const docs = await this.ticketTypeModel
      .find({ tenantId }, { name: 1 })
      .lean()
      .exec();
    for (const d of docs as any[]) {
      this.typeMap.set(String(d._id), d.name);
    }
  }

  private async loadSourceMap(tenantId: string): Promise<void> {
    this.sourceMap.clear();
    const docs = await this.ticketSourceModel
      .find({ tenantId }, { name: 1 })
      .lean()
      .exec();
    for (const d of docs as any[]) {
      this.sourceMap.set(String(d._id), d.name);
    }
  }

  private async loadGroupMap(tenantId: string): Promise<void> {
    this.groupMap.clear();
    const docs = await this.groupModel
      .find({ tenantId }, { name: 1 })
      .lean()
      .exec();
    for (const d of docs as any[]) {
      this.groupMap.set(String(d._id), d.name);
    }
  }

  // ── BaseExportProcessor abstract implementations ──────────────────

  protected getModuleConfig(): ExportModuleConfig {
    return {
      module: 'ticket',
      displayName: 'Ticket',
      maskingResource: 'Ticket',
      columns: this.resolvedColumns.length > 0 ? this.resolvedColumns : STATIC_COLUMNS,
      selectableColumns: new Set(STATIC_COLUMNS.map((c) => c.path)),
      batchSize: 1_000,
      hardCap: DEFAULT_EXPORT_HARD_CAP,
      throttleMs: 50,
      gzipCsv: false,
      completionChannel: 'socket:ticket:export:completed',
      queueName: TICKET_EXPORT_QUEUE,
    };
  }

  protected getStorage(): ExportStorageService {
    return this.storage;
  }
  protected getExportJobModel(): Model<any> {
    return this.exportJobModel;
  }
  protected getLockService(): RedisLockService {
    return this.lockService;
  }
  protected getRedis(): Redis {
    return this.redis;
  }
  protected getMaskingService(): ExportMaskingService {
    return this.maskingService;
  }
  protected getConnection(): Connection {
    return this.connection;
  }

  protected openCursor(
    data: TicketExportJobData,
    opts: ExportQueryOptions,
  ): ExportCursor {
    return this.repository.streamForExport(
      { ids: data.ids, filters: data.legacyFilters },
      opts,
    ) as ExportCursor;
  }

  protected countForProgress(
    data: TicketExportJobData,
    maxTimeMS: number,
  ): Promise<number> {
    return this.repository.countForExport(
      { ids: data.ids, filters: data.legacyFilters },
      maxTimeMS,
    );
  }
}
