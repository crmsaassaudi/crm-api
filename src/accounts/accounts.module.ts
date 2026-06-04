import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { AccountRepository } from './infrastructure/persistence/document/repositories/account.repository';
import {
  AccountSchema,
  AccountSchemaClass,
} from './infrastructure/persistence/document/entities/account.schema';
import { AccountImportProcessor } from './import/account-import.processor';
import { isWorkerRuntime } from '../config/runtime-role';
import { ACCOUNT_IMPORT_QUEUE } from './accounts.constants';
import {
  ImportJobSchema,
  ImportJobSchemaClass,
} from '../common/import/import-job.schema';

const workerProviders = isWorkerRuntime() ? [AccountImportProcessor] : [];

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AccountSchemaClass.name, schema: AccountSchema },
      { name: ImportJobSchemaClass.name, schema: ImportJobSchema },
    ]),
    BullModule.registerQueue({
      name: ACCOUNT_IMPORT_QUEUE,
      defaultJobOptions: {
        // No retry: import is not idempotent — a retry would re-insert rows.
        attempts: 1,
        removeOnComplete: 50,
        removeOnFail: 200,
      },
    }),
    BullBoardModule.forFeature({
      name: ACCOUNT_IMPORT_QUEUE,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [AccountsController],
  providers: [AccountsService, AccountRepository, ...workerProviders],
  exports: [AccountsService],
})
export class AccountsModule {}
