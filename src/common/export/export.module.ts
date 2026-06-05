import { Module, Global } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ExportJobSchema, ExportJobSchemaClass } from './export-job.schema';
import { ExportStorageFactory } from './export-storage.service';
import { ExportMaskingService } from './export-masking.service';
import { ExportRequestService } from './export-request.service';
import { ExportCleanupCron } from './export-cleanup.cron';
import { ActivityLogModule } from '../../activity-log/activity-log.module';
import { isAnyWorkerRuntime } from '../../config/runtime-role';

// The cleanup cron only runs in processes that consume queues (worker /
// all-in-one) — never in a dedicated API-only process.
const cronProviders = isAnyWorkerRuntime() ? [ExportCleanupCron] : [];

/**
 * Shared export infrastructure module (mirror of SharedImportModule).
 *
 * Provides:
 *   - ExportStorageFactory: module-specific dual-mode storage instances
 *   - ExportMaskingService: context-free masking for the worker
 *   - ExportJobSchemaClass: shared `export_jobs` model (history + audit)
 *
 * Format writers and the progress tracker are instantiated per-job (not
 * singletons), so they are NOT provided here.
 */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ExportJobSchemaClass.name, schema: ExportJobSchema },
    ]),
    ActivityLogModule,
  ],
  providers: [
    ExportStorageFactory,
    ExportMaskingService,
    ExportRequestService,
    ...cronProviders,
  ],
  exports: [
    ExportStorageFactory,
    ExportMaskingService,
    ExportRequestService,
    MongooseModule,
  ],
})
export class SharedExportModule {}
