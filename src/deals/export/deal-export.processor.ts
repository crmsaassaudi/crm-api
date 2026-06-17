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
import { UserSchemaClass } from '../../users/infrastructure/persistence/document/entities/user.schema';
import { DealStageSchemaClass } from '../../deal-settings/entities/deal-stage.schema';
import { DealSourceSchemaClass } from '../../deal-settings/entities/deal-source.schema';
import { AccountSchemaClass } from '../../accounts/infrastructure/persistence/document/entities/account.schema';

// ── Helpers ─────────────────────────────────────────────────────────

const resolve = (map: Map<string, string>, val: unknown): string =>
  map.get(String(val ?? '')) || String(val ?? '');

// ── Columns ─────────────────────────────────────────────────────────

function buildDealExportColumns(
  userMap: Map<string, string>,
  stageMap: Map<string, string>,
  sourceMap: Map<string, string>,
  accountMap: Map<string, string>,
): ExportColumn[] {
  return [
    { header: 'id', path: 'id' },
    { header: 'name', path: 'name' },
    { header: 'title', path: 'title' },
    { header: 'value', path: 'value' },
    { header: 'currency', path: 'currency' },
    { header: 'probability', path: 'probability' },
    {
      header: 'stage',
      path: 'stageId',
      format: (val) => resolve(stageMap, val),
    },
    {
      header: 'account',
      path: 'accountId',
      format: (val) => resolve(accountMap, val),
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
    { header: 'closeDate', path: 'closeDate' },
    { header: 'lostReason', path: 'lostReason' },
    { header: 'tags', path: 'tags' },
    { header: 'createdAt', path: 'createdAt' },
  ];
}

const STATIC_COLUMNS: readonly ExportColumn[] = [
  { header: 'id', path: 'id' },
  { header: 'name', path: 'name' },
  { header: 'title', path: 'title' },
  { header: 'value', path: 'value' },
  { header: 'currency', path: 'currency' },
  { header: 'probability', path: 'probability' },
  { header: 'stage', path: 'stageId' },
  { header: 'account', path: 'accountId' },
  { header: 'source', path: 'sourceId' },
  { header: 'owner', path: 'ownerId' },
  { header: 'closeDate', path: 'closeDate' },
  { header: 'lostReason', path: 'lostReason' },
  { header: 'tags', path: 'tags' },
  { header: 'createdAt', path: 'createdAt' },
] as const;

export interface DealExportJobData extends BaseExportJobData {
  ids?: string[];
  legacyFilters?: Record<string, any>;
}

@Processor(DEAL_EXPORT_QUEUE, EXPORT_WORKER_OPTIONS)
export class DealExportProcessor extends BaseExportProcessor<DealExportJobData> {
  protected readonly logger = new Logger(DealExportProcessor.name);
  protected readonly cls: ClsService;
  private readonly storage: ExportStorageService;

  // ── Per-job lookup maps ───────────────────────────────────────────
  private userMap = new Map<string, string>();
  private stageMap = new Map<string, string>();
  private sourceMap = new Map<string, string>();
  private accountMap = new Map<string, string>();
  private resolvedColumns: ExportColumn[] = [];

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
    @InjectModel(UserSchemaClass.name)
    private readonly userModel: Model<any>,
    @InjectModel(DealStageSchemaClass.name)
    private readonly dealStageModel: Model<any>,
    @InjectModel(DealSourceSchemaClass.name)
    private readonly dealSourceModel: Model<any>,
    @InjectModel(AccountSchemaClass.name)
    private readonly accountModel: Model<any>,
  ) {
    super();
    this.cls = cls;
    this.storage = storageFactory.create('deals');
  }

  // ── Lifecycle hook ────────────────────────────────────────────────

  protected async beforeExport(data: DealExportJobData): Promise<void> {
    await Promise.all([
      this.loadUserMap(data.tenantId),
      this.loadStageMap(data.tenantId),
      this.loadSourceMap(data.tenantId),
      this.loadAccountMap(data.tenantId),
    ]);

    this.resolvedColumns = buildDealExportColumns(
      this.userMap,
      this.stageMap,
      this.sourceMap,
      this.accountMap,
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

  private async loadStageMap(tenantId: string): Promise<void> {
    this.stageMap.clear();
    const docs = await this.dealStageModel
      .find({ tenantId }, { label: 1 })
      .lean()
      .exec();
    for (const d of docs as any[]) {
      this.stageMap.set(String(d._id), d.label);
    }
  }

  private async loadSourceMap(tenantId: string): Promise<void> {
    this.sourceMap.clear();
    const docs = await this.dealSourceModel
      .find({ tenantId }, { name: 1 })
      .lean()
      .exec();
    for (const d of docs as any[]) {
      this.sourceMap.set(String(d._id), d.name);
    }
  }

  private async loadAccountMap(tenantId: string): Promise<void> {
    this.accountMap.clear();
    const docs = await this.accountModel
      .find({ tenantId }, { name: 1 })
      .lean()
      .exec();
    for (const d of docs as any[]) {
      this.accountMap.set(String(d._id), d.name);
    }
  }

  // ── BaseExportProcessor abstract implementations ──────────────────

  protected getModuleConfig(): ExportModuleConfig {
    return {
      module: 'deal',
      displayName: 'Deal',
      maskingResource: 'Deal',
      columns:
        this.resolvedColumns.length > 0 ? this.resolvedColumns : STATIC_COLUMNS,
      selectableColumns: new Set(STATIC_COLUMNS.map((c) => c.path)),
      batchSize: 1_000,
      hardCap: DEFAULT_EXPORT_HARD_CAP,
      throttleMs: 50,
      gzipCsv: false,
      completionChannel: 'socket:deal:export:completed',
      queueName: DEAL_EXPORT_QUEUE,
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
