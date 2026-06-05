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
import { ACCOUNT_EXPORT_QUEUE } from '../accounts.constants';
import { AccountRepository } from '../infrastructure/persistence/document/repositories/account.repository';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { RedisLockService } from '../../redis/redis-lock.service';

const ACCOUNT_EXPORT_COLUMNS: readonly ExportColumn[] = [
  { header: 'id', path: 'id' },
  { header: 'name', path: 'name' },
  { header: 'website', path: 'website' },
  { header: 'industry', path: 'industry' },
  { header: 'emails', path: 'emails' },
  { header: 'phones', path: 'phones' },
  { header: 'taxId', path: 'taxId' },
  { header: 'annualRevenue', path: 'annualRevenue' },
  { header: 'numberOfEmployees', path: 'numberOfEmployees' },
  { header: 'tags', path: 'tags' },
  { header: 'statusId', path: 'statusId' },
  { header: 'typeId', path: 'typeId' },
  { header: 'ownerId', path: 'ownerId' },
  { header: 'createdAt', path: 'createdAt' },
] as const;

const ACCOUNT_EXPORT_CONFIG: ExportModuleConfig = {
  module: 'account',
  displayName: 'Account',
  maskingResource: 'Account',
  columns: ACCOUNT_EXPORT_COLUMNS,
  selectableColumns: new Set(ACCOUNT_EXPORT_COLUMNS.map((c) => c.path)),
  batchSize: 1_000,
  hardCap: DEFAULT_EXPORT_HARD_CAP,
  throttleMs: 50,
  gzipCsv: false,
  completionChannel: 'socket:account:export:completed',
  queueName: ACCOUNT_EXPORT_QUEUE,
};

export interface AccountExportJobData extends BaseExportJobData {
  ids?: string[];
  legacyFilters?: Record<string, any>;
}

@Processor(ACCOUNT_EXPORT_QUEUE, EXPORT_WORKER_OPTIONS)
export class AccountExportProcessor extends BaseExportProcessor<AccountExportJobData> {
  protected readonly logger = new Logger(AccountExportProcessor.name);
  protected readonly cls: ClsService;
  private readonly storage: ExportStorageService;

  constructor(
    private readonly repository: AccountRepository,
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
    this.storage = storageFactory.create('accounts');
  }

  protected getModuleConfig(): ExportModuleConfig {
    return ACCOUNT_EXPORT_CONFIG;
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
    data: AccountExportJobData,
    opts: ExportQueryOptions,
  ): ExportCursor {
    return this.repository.streamForExport(
      { ids: data.ids, filters: data.legacyFilters },
      opts,
    ) as ExportCursor;
  }

  protected countForProgress(
    data: AccountExportJobData,
    maxTimeMS: number,
  ): Promise<number> {
    return this.repository.countForExport(
      { ids: data.ids, filters: data.legacyFilters },
      maxTimeMS,
    );
  }
}
