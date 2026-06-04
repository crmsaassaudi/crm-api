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
import { isWorkerRuntime } from '../config/runtime-role';
import { DEAL_IMPORT_QUEUE } from './deals.constants';

const workerProviders = isWorkerRuntime() ? [DealImportProcessor] : [];

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DealSchemaClass.name, schema: DealSchema },
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
  ],
  controllers: [DealsController],
  providers: [DealsService, DealRepository, ...workerProviders],
  exports: [DealsService, DealRepository],
})
export class DealsModule {}
