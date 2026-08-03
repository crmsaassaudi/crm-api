import { Processor } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import Redis from 'ioredis';

import {
  BaseExportJobData,
  BaseExportProcessor,
  DEFAULT_EXPORT_HARD_CAP,
  EXPORT_WORKER_OPTIONS,
  ExportColumn,
  ExportCursor,
  ExportJobDocument,
  ExportJobSchemaClass,
  ExportMaskingService,
  ExportModuleConfig,
  ExportQueryOptions,
  ExportStorageFactory,
  ExportStorageService,
} from '../../common/export';
import { loadCustomFieldExportColumns } from '../../common/export/custom-field-export-columns';
import { CustomFieldsService } from '../../custom-fields/custom-fields.service';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { RedisLockService } from '../../redis/redis-lock.service';
import { TaskRepository } from '../infrastructure/persistence/document/repositories/task.repository';
import { TASK_EXPORT_QUEUE } from '../tasks.constants';

const STATIC_COLUMNS: readonly ExportColumn[] = [
  { header: 'id', path: 'id' },
  { header: 'title', path: 'title' },
  { header: 'description', path: 'description' },
  { header: 'priority', path: 'priority' },
  { header: 'statusId', path: 'statusId' },
  { header: 'categoryId', path: 'categoryId' },
  { header: 'sourceId', path: 'sourceId' },
  { header: 'ownerId', path: 'ownerId' },
  // No 'assignedToId' column: the field does not exist on TaskSchema, so it
  // exported an empty column for every row and advertised a second person axis
  // the module does not have.
  { header: 'dueDate', path: 'dueDate' },
  { header: 'completedAt', path: 'completedAt' },
  { header: 'createdAt', path: 'createdAt' },
  { header: 'updatedAt', path: 'updatedAt' },
] as const;

interface TaskExportJobData extends BaseExportJobData {
  ids?: string[];
  legacyFilters?: Record<string, unknown>;
}

@Processor(TASK_EXPORT_QUEUE, EXPORT_WORKER_OPTIONS)
export class TaskExportProcessor extends BaseExportProcessor<TaskExportJobData> {
  protected readonly logger = new Logger(TaskExportProcessor.name);
  protected readonly cls: ClsService;
  private readonly storage: ExportStorageService;

  constructor(
    private readonly repository: TaskRepository,
    storageFactory: ExportStorageFactory,
    private readonly lockService: RedisLockService,
    private readonly maskingService: ExportMaskingService,
    cls: ClsService,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    @InjectModel(ExportJobSchemaClass.name)
    private readonly exportJobModel: Model<ExportJobDocument>,
    @InjectConnection() private readonly connection: Connection,
    @Optional() private readonly customFields?: CustomFieldsService,
  ) {
    super();
    this.cls = cls;
    this.storage = storageFactory.create('tasks');
  }

  protected async beforeExport(): Promise<ExportModuleConfig> {
    return this.buildModuleConfig([
      ...STATIC_COLUMNS,
      ...(await loadCustomFieldExportColumns(this.customFields, 'Task')),
    ]);
  }

  protected getModuleConfig(): ExportModuleConfig {
    return this.buildModuleConfig([...STATIC_COLUMNS]);
  }

  private buildModuleConfig(columns: ExportColumn[]): ExportModuleConfig {
    return {
      module: 'task',
      displayName: 'Task',
      maskingResource: 'Task',
      columns,
      selectableColumns: new Set(columns.map((column) => column.path)),
      batchSize: 1_000,
      hardCap: DEFAULT_EXPORT_HARD_CAP,
      throttleMs: 50,
      gzipCsv: false,
      completionChannel: 'socket:task:export:completed',
      queueName: TASK_EXPORT_QUEUE,
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
    data: TaskExportJobData,
    opts: ExportQueryOptions,
  ): ExportCursor {
    return this.repository.streamForExport(
      { ids: data.ids, filters: data.legacyFilters },
      opts,
    ) as ExportCursor;
  }
  protected countForProgress(
    data: TaskExportJobData,
    maxTimeMS: number,
  ): Promise<number> {
    return this.repository.countForExport(
      { ids: data.ids, filters: data.legacyFilters },
      maxTimeMS,
    );
  }
}
