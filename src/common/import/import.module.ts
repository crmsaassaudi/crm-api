import { Module, Global } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ImportJobSchema, ImportJobSchemaClass } from './import-job.schema';
import { ImportStorageFactory } from './import-storage.service';

/**
 * Shared import infrastructure module.
 *
 * Provides:
 *   - ImportStorageFactory: for creating module-specific storage instances
 *   - ImportJobSchemaClass: MongoDB model for cross-module import history
 *
 * Each module's own Module should import SharedImportModule and use the
 * factory to create its own storage service.
 *
 * Note: parsers, dedup engine, reference resolver, report service, and
 * progress tracker are instantiated per-job (not singletons), so they
 * are NOT provided here.
 */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ImportJobSchemaClass.name, schema: ImportJobSchema },
    ]),
  ],
  providers: [ImportStorageFactory],
  exports: [ImportStorageFactory, MongooseModule],
})
export class SharedImportModule {}
