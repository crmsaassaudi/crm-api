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
import { DEAL_EXPORT_QUEUE } from '../deals.constants';
import { DealRepository } from '../infrastructure/persistence/document/repositories/deal.repository';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { RedisLockService } from '../../redis/redis-lock.service';

const DEAL_EXPORT_COLUMNS: readonly ExportColumn[] = [
  { header: 'id', path: 'id' },
  { header: 'name', path: 'name' },
  { header: 'title', path: 'title' },
  { header: 'value', path: 'value' },
  { header: 'currency', path: 'currency' },
  { header: 'probability', path: 'probability' },
  { header: 'stageId', path: 'stageId' },
  { header: 'accountId', path: 'accountId' },
  { header: 'sourceId', path: 'sourceId' },
  { header: 'ownerId', path: 'ownerId' },
  { header: 'closeDate', path: 'closeDate' },
  { header: 'lostReason', path: 'lostReason' },
  { header: 'tags', path: 'tags' },
  { header: 'createdAt', path: 'createdAt' },
] as const;

const DEAL_EXPORT_CONFIG: ExportModuleConfig = {
  module: 'deal',
  displayName: 'Deal',
  maskingResource: 'Deal',
  columns: DEAL_EXPORT_COLUMNS,
  selectableColumns: new Set(DEAL_EXPORT_COLUMNS.map((c) => c.path)),
  batchSize: 1_000,
  hardCap: DEFAULT_EXPORT_HARD_CAP,
  throttleMs: 50,
  gzipCsv: false,
  completionChannel: 'socket:deal:export:completed',
  queueName: DEAL_EXPORT_QUEUE,
};

export interface DealExportJobData extends BaseExportJobData {
  ids?: string[];
  legacyFilters?: Record<string, any>;
}

@Processor(DEAL_EXPORT_QUEUE, EXPORT_WORKER_OPTIONS)
export class DealExportProcessor extends BaseExportProcessor<DealExportJobData> {
  protected readonly logger = new Logger(DealExportProcessor.name);
  protected readonly cls: ClsService;
  private readonly storage: ExportStorageService;

  constructor(
    private readonly repository: DealRepository,
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
    this.storage = storageFactory.create('deals');
  }

  protected getModuleConfig(): ExportModuleConfig {
    return DEAL_EXPORT_CONFIG;
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
    data: DealExportJobData,
    opts: ExportQueryOptions,
  ): ExportCursor {
    return this.repository.streamForExport(
      { ids: data.ids, filters: data.legacyFilters },
      opts,
    ) as ExportCursor;
  }

  protected countForProgress(
    data: DealExportJobData,
    maxTimeMS: number,
  ): Promise<number> {
    return this.repository.countForExport(
      { ids: data.ids, filters: data.legacyFilters },
      maxTimeMS,
    );
  }
}
