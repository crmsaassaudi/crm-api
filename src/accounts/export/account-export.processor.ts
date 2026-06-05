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
import {
  UserSchemaClass,
} from '../../users/infrastructure/persistence/document/entities/user.schema';
import {
  AccountStatusSchemaClass,
} from '../../account-settings/entities/account-status.schema';
import {
  AccountTypeSchemaClass,
} from '../../account-settings/entities/account-type.schema';

// ── Helpers ─────────────────────────────────────────────────────────

const resolve = (map: Map<string, string>, val: unknown): string =>
  map.get(String(val ?? '')) || String(val ?? '');

// ── Columns ─────────────────────────────────────────────────────────

function buildAccountExportColumns(
  userMap: Map<string, string>,
  statusMap: Map<string, string>,
  typeMap: Map<string, string>,
): ExportColumn[] {
  return [
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
      header: 'owner',
      path: 'ownerId',
      format: (val) => resolve(userMap, val),
    },
    { header: 'createdAt', path: 'createdAt' },
  ];
}

const STATIC_COLUMNS: readonly ExportColumn[] = [
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
  { header: 'status', path: 'statusId' },
  { header: 'type', path: 'typeId' },
  { header: 'owner', path: 'ownerId' },
  { header: 'createdAt', path: 'createdAt' },
] as const;

export interface AccountExportJobData extends BaseExportJobData {
  ids?: string[];
  legacyFilters?: Record<string, any>;
}

@Processor(ACCOUNT_EXPORT_QUEUE, EXPORT_WORKER_OPTIONS)
export class AccountExportProcessor extends BaseExportProcessor<AccountExportJobData> {
  protected readonly logger = new Logger(AccountExportProcessor.name);
  protected readonly cls: ClsService;
  private readonly storage: ExportStorageService;

  // ── Per-job lookup maps ───────────────────────────────────────────
  private userMap = new Map<string, string>();
  private statusMap = new Map<string, string>();
  private typeMap = new Map<string, string>();
  private resolvedColumns: ExportColumn[] = [];

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
    @InjectModel(UserSchemaClass.name)
    private readonly userModel: Model<any>,
    @InjectModel(AccountStatusSchemaClass.name)
    private readonly accountStatusModel: Model<any>,
    @InjectModel(AccountTypeSchemaClass.name)
    private readonly accountTypeModel: Model<any>,
  ) {
    super();
    this.cls = cls;
    this.storage = storageFactory.create('accounts');
  }

  // ── Lifecycle hook ────────────────────────────────────────────────

  protected async beforeExport(data: AccountExportJobData): Promise<void> {
    await Promise.all([
      this.loadUserMap(data.tenantId),
      this.loadStatusMap(data.tenantId),
      this.loadTypeMap(data.tenantId),
    ]);

    this.resolvedColumns = buildAccountExportColumns(
      this.userMap,
      this.statusMap,
      this.typeMap,
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
    const docs = await this.accountStatusModel
      .find({ tenantId }, { label: 1 })
      .lean()
      .exec();
    for (const d of docs as any[]) {
      this.statusMap.set(String(d._id), d.label);
    }
  }

  private async loadTypeMap(tenantId: string): Promise<void> {
    this.typeMap.clear();
    const docs = await this.accountTypeModel
      .find({ tenantId }, { name: 1 })
      .lean()
      .exec();
    for (const d of docs as any[]) {
      this.typeMap.set(String(d._id), d.name);
    }
  }

  // ── BaseExportProcessor abstract implementations ──────────────────

  protected getModuleConfig(): ExportModuleConfig {
    return {
      module: 'account',
      displayName: 'Account',
      maskingResource: 'Account',
      columns: this.resolvedColumns.length > 0 ? this.resolvedColumns : STATIC_COLUMNS,
      selectableColumns: new Set(STATIC_COLUMNS.map((c) => c.path)),
      batchSize: 1_000,
      hardCap: DEFAULT_EXPORT_HARD_CAP,
      throttleMs: 50,
      gzipCsv: false,
      completionChannel: 'socket:account:export:completed',
      queueName: ACCOUNT_EXPORT_QUEUE,
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
