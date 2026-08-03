import { Processor } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
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
} from '../common/export';
import { CONTACT_EXPORT_QUEUE } from './contacts.constants';
import { ContactRepository } from './infrastructure/persistence/document/repositories/contact.repository';
import { IOREDIS_CLIENT } from '../redis/redis.tokens';
import { RedisLockService } from '../redis/redis-lock.service';
import { UserSchemaClass } from '../users/infrastructure/persistence/document/entities/user.schema';
import { CrmSettingsService } from '../crm-settings/crm-settings.service';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { loadCustomFieldExportColumns } from '../common/export/custom-field-export-columns';

// Helpers

/** Resolve an ObjectId string via a pre-loaded map; fall back to raw value. */
const resolve = (map: Map<string, string>, val: unknown): string =>
  map.get(String(val ?? '')) ?? String(val ?? '');

// Columns
// Column definitions are built per-job so the `format` closures can
// capture the freshly-loaded lookup maps.

function buildContactExportColumns(
  userMap: Map<string, string>,
  stageMap: Map<string, string>,
  statusMap: Map<string, string>,
): ExportColumn[] {
  return [
    { header: 'id', path: 'id' },
    { header: 'firstName', path: 'firstName' },
    { header: 'lastName', path: 'lastName' },
    { header: 'emails', path: 'emails' },
    { header: 'phones', path: 'phones' },
    { header: 'companyName', path: 'companyName' },
    { header: 'title', path: 'title' },
    {
      header: 'lifecycleStage',
      path: 'lifecycleStageId',
      format: (val) => resolve(stageMap, val),
    },
    {
      header: 'status',
      path: 'statusId',
      format: (val) => resolve(statusMap, val),
    },
    { header: 'lastActivityAt', path: 'lastActivityAt' },
    {
      header: 'owner',
      path: 'ownerId',
      format: (val) => resolve(userMap, val),
    },
    { header: 'createdAt', path: 'createdAt' },
    { header: 'updatedAt', path: 'updatedAt' },
    {
      header: 'createdBy',
      path: 'createdById',
      format: (val) => resolve(userMap, val),
    },
    {
      header: 'updatedBy',
      path: 'updatedById',
      format: (val) => resolve(userMap, val),
    },
  ];
}

/** Static config — columns are replaced per-job via getModuleConfig(). */
const STATIC_COLUMNS: readonly ExportColumn[] = [
  { header: 'id', path: 'id' },
  { header: 'firstName', path: 'firstName' },
  { header: 'lastName', path: 'lastName' },
  { header: 'emails', path: 'emails' },
  { header: 'phones', path: 'phones' },
  { header: 'companyName', path: 'companyName' },
  { header: 'title', path: 'title' },
  { header: 'lifecycleStage', path: 'lifecycleStageId' },
  { header: 'status', path: 'statusId' },
  { header: 'lastActivityAt', path: 'lastActivityAt' },
  { header: 'owner', path: 'ownerId' },
  { header: 'createdAt', path: 'createdAt' },
  { header: 'updatedAt', path: 'updatedAt' },
  { header: 'createdBy', path: 'createdById' },
  { header: 'updatedBy', path: 'updatedById' },
] as const;

/**
 * Contact export job data. `ids` / `legacyFilters` feed the repository's
 * existing export filter; `filter` (from BaseExportJobData) is the typed
 * snapshot persisted for history/audit.
 */
export interface ContactExportJobData extends BaseExportJobData {
  ids?: string[];
  legacyFilters?: Record<string, any>;
}

@Processor(CONTACT_EXPORT_QUEUE, EXPORT_WORKER_OPTIONS)
export class ContactExportProcessor extends BaseExportProcessor<ContactExportJobData> {
  protected readonly logger = new Logger(ContactExportProcessor.name);
  protected readonly cls: ClsService;
  private readonly storage: ExportStorageService;

  constructor(
    private readonly repository: ContactRepository,
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
    private readonly crmSettingsService: CrmSettingsService,
    @Optional() private readonly customFields?: CustomFieldsService,
  ) {
    super();
    this.cls = cls;
    this.storage = storageFactory.create('contacts');
  }

  // Lifecycle hook: pre-load lookup maps

  protected async beforeExport(
    data: ContactExportJobData,
  ): Promise<ExportModuleConfig> {
    const [userMap, lifecycle, dynamicColumns] = await Promise.all([
      this.loadUserMap(data.tenantId),
      this.loadLifecycleMaps(data.tenantId),
      loadCustomFieldExportColumns(this.customFields, 'Contact'),
    ]);

    return this.buildModuleConfig([
      ...buildContactExportColumns(
        userMap,
        lifecycle.stageMap,
        lifecycle.statusMap,
      ),
      ...dynamicColumns,
    ]);
  }

  private async loadUserMap(tenantId: string): Promise<Map<string, string>> {
    const userMap = new Map<string, string>();
    const users = await this.userModel
      .find(
        { 'tenants.tenantId': tenantId },
        { firstName: 1, lastName: 1, email: 1 },
      )
      .lean()
      .exec();
    for (const u of users as any[]) {
      const name = [u.firstName, u.lastName].filter(Boolean).join(' ');
      userMap.set(String(u._id), name || u.email || String(u._id));
    }
    return userMap;
  }

  private async loadLifecycleMaps(tenantId: string): Promise<{
    stageMap: Map<string, string>;
    statusMap: Map<string, string>;
  }> {
    const stageMap = new Map<string, string>();
    const statusMap = new Map<string, string>();
    try {
      const setting = await this.crmSettingsService.getSetting(
        'contact_lifecycle',
        tenantId,
      );
      const stages = Array.isArray(setting?.stages) ? setting.stages : [];
      this.parseStagesAndStatuses(stages, stageMap, statusMap);
    } catch {
      // Setting not found — maps stay empty, raw IDs are used as fallback.
    }
    return { stageMap, statusMap };
  }

  private parseStagesAndStatuses(
    stages: any[],
    stageMap: Map<string, string>,
    statusMap: Map<string, string>,
  ) {
    for (const stage of stages) {
      if (stage.id) stageMap.set(stage.id, stage.name ?? stage.apiName);
      if (stage.apiName)
        stageMap.set(stage.apiName, stage.name ?? stage.apiName);

      this.parseStatuses(stage.statuses, statusMap);
    }
  }

  private parseStatuses(statuses: any, statusMap: Map<string, string>) {
    if (!Array.isArray(statuses)) return;
    for (const status of statuses) {
      if (status.id) statusMap.set(status.id, status.label ?? status.apiName);
      if (status.apiName)
        statusMap.set(status.apiName, status.label ?? status.apiName);
    }
  }

  // BaseExportProcessor abstract implementations

  protected getModuleConfig(): ExportModuleConfig {
    return this.buildModuleConfig([...STATIC_COLUMNS]);
  }

  private buildModuleConfig(columns: ExportColumn[]): ExportModuleConfig {
    return {
      module: 'contact',
      displayName: 'Contact',
      maskingResource: 'Contact',
      columns,
      selectableColumns: new Set(columns.map((column) => column.path)),
      batchSize: 1_000,
      hardCap: DEFAULT_EXPORT_HARD_CAP,
      throttleMs: 50,
      gzipCsv: false,
      completionChannel: 'socket:contact:export:completed',
      queueName: CONTACT_EXPORT_QUEUE,
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
    data: ContactExportJobData,
    opts: ExportQueryOptions,
  ): ExportCursor {
    return this.repository.streamForExport(
      { ids: data.ids, filters: data.legacyFilters },
      opts,
    ) as ExportCursor;
  }

  protected countForProgress(
    data: ContactExportJobData,
    maxTimeMS: number,
  ): Promise<number> {
    return this.repository.countForExport(
      { ids: data.ids, filters: data.legacyFilters },
      maxTimeMS,
    );
  }
}
