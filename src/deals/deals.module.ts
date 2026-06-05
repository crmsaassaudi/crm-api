import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { DealsController } from './deals.controller';
import { DealsService } from './deals.service';
import { DealRepository } from './infrastructure/persistence/document/repositories/deal.repository';
import {
  DealSchema,
  DealSchemaClass,
} from './infrastructure/persistence/document/entities/deal.schema';
import { DealImportProcessor } from './import/deal-import.processor';
import { DealExportProcessor } from './export/deal-export.processor';
import { isWorkerRuntime } from '../config/runtime-role';
import { DEAL_IMPORT_QUEUE, DEAL_EXPORT_QUEUE } from './deals.constants';
import {
  ImportJobSchema,
  ImportJobSchemaClass,
} from '../common/import/import-job.schema';

const workerProviders = isWorkerRuntime()
  ? [DealImportProcessor, DealExportProcessor]
  : [];

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DealSchemaClass.name, schema: DealSchema },
      { name: ImportJobSchemaClass.name, schema: ImportJobSchema },
    ]),
    BullModule.registerQueue({
      name: DEAL_IMPORT_QUEUE,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 50,
        removeOnFail: 200,
      },
    }),
    BullBoardModule.forFeature({
      name: DEAL_IMPORT_QUEUE,
      adapter: BullMQAdapter,
    }),
    BullModule.registerQueue({
      name: DEAL_EXPORT_QUEUE,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    }),
    BullBoardModule.forFeature({
      name: DEAL_EXPORT_QUEUE,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [DealsController],
  providers: [DealsService, DealRepository, ...workerProviders],
  exports: [DealsService, DealRepository],
})
export class DealsModule {}
