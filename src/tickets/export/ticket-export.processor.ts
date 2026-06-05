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

const TICKET_EXPORT_COLUMNS: readonly ExportColumn[] = [
  { header: 'id', path: 'id' },
  { header: 'subject', path: 'subject' },
  { header: 'priority', path: 'priority' },
  { header: 'channel', path: 'channel' },
  { header: 'statusId', path: 'statusId' },
  { header: 'typeId', path: 'typeId' },
  { header: 'sourceId', path: 'sourceId' },
  { header: 'ownerId', path: 'ownerId' },
  { header: 'groupId', path: 'groupId' },
  { header: 'tags', path: 'tags' },
  { header: 'createdAt', path: 'createdAt' },
] as const;

const TICKET_EXPORT_CONFIG: ExportModuleConfig = {
  module: 'ticket',
  displayName: 'Ticket',
  maskingResource: 'Ticket',
  columns: TICKET_EXPORT_COLUMNS,
  selectableColumns: new Set(TICKET_EXPORT_COLUMNS.map((c) => c.path)),
  batchSize: 1_000,
  hardCap: DEFAULT_EXPORT_HARD_CAP,
  throttleMs: 50,
  gzipCsv: false,
  completionChannel: 'socket:ticket:export:completed',
  queueName: TICKET_EXPORT_QUEUE,
};

export interface TicketExportJobData extends BaseExportJobData {
  ids?: string[];
  legacyFilters?: Record<string, any>;
}

@Processor(TICKET_EXPORT_QUEUE, EXPORT_WORKER_OPTIONS)
export class TicketExportProcessor extends BaseExportProcessor<TicketExportJobData> {
  protected readonly logger = new Logger(TicketExportProcessor.name);
  protected readonly cls: ClsService;
  private readonly storage: ExportStorageService;

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
  ) {
    super();
    this.cls = cls;
    this.storage = storageFactory.create('tickets');
  }

  protected getModuleConfig(): ExportModuleConfig {
    return TICKET_EXPORT_CONFIG;
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
