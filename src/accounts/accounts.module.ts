import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { AccountMergeService } from './merge/account-merge.service';
import { AccountPurgeService } from './account-purge.service';
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
import { TagsModule } from '../tags/tags.module';
import { AutomationOutboxModule } from '../automation-rules/events/automation-outbox.module';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { ObjectManagerModule } from '../object-manager/object-manager.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';

const workerProviders = isWorkerRuntime()
  ? [
      AccountImportProcessor,
      AccountExportProcessor,
      // Retention purge: the only path that hard-deletes an account, and the cascade
      // that keeps deals, tickets and contacts from being orphaned by it. Gated on the
      // worker runtime like every other cron here — an unconditional provider would
      // schedule it in every API process too, and the Redis lock would then be load-
      // bearing for correctness rather than a safety net.
      AccountPurgeService,
    ]
  : [];

@Module({
  imports: [
    // Supplies CustomFieldValueValidator so submitted `customFields` are checked
    // against the tenant's registry instead of being written as opaque Mixed.
    CustomFieldsModule,
    ObjectManagerModule,
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
    TagsModule,
    AutomationOutboxModule,
    // Supplies ActivityLogService for the account timeline route.
    ActivityLogModule,
  ],
  controllers: [AccountsController],
  providers: [
    AccountsService,
    AccountRepository,
    // RedisLockService and EntityAuditService come from @Global() modules, so merge
    // needs no extra imports here.
    AccountMergeService,
    ...workerProviders,
  ],
  exports: [AccountsService, AccountMergeService],
})
export class AccountsModule {}
