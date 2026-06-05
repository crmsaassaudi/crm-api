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
import { AccountExportProcessor } from './export/account-export.processor';
import { isWorkerRuntime } from '../config/runtime-role';
import {
  ACCOUNT_IMPORT_QUEUE,
  ACCOUNT_EXPORT_QUEUE,
} from './accounts.constants';
import {
  ImportJobSchema,
  ImportJobSchemaClass,
} from '../common/import/import-job.schema';
import {
  UserSchema,
  UserSchemaClass,
} from '../users/infrastructure/persistence/document/entities/user.schema';
import {
  AccountStatusSchema,
  AccountStatusSchemaClass,
} from '../account-settings/entities/account-status.schema';
import {
  AccountTypeSchema,
  AccountTypeSchemaClass,
} from '../account-settings/entities/account-type.schema';

const workerProviders = isWorkerRuntime()
  ? [AccountImportProcessor, AccountExportProcessor]
  : [];

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AccountSchemaClass.name, schema: AccountSchema },
      { name: ImportJobSchemaClass.name, schema: ImportJobSchema },
      { name: UserSchemaClass.name, schema: UserSchema },
      { name: AccountStatusSchemaClass.name, schema: AccountStatusSchema },
      { name: AccountTypeSchemaClass.name, schema: AccountTypeSchema },
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
    BullModule.registerQueue({
      name: ACCOUNT_EXPORT_QUEUE,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    }),
    BullBoardModule.forFeature({
      name: ACCOUNT_EXPORT_QUEUE,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [AccountsController],
  providers: [AccountsService, AccountRepository, ...workerProviders],
  exports: [AccountsService],
})
export class AccountsModule {}
