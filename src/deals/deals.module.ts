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
import { DealPurgeService } from './deal-purge.service';
import { DealFollowUpService } from './deal-follow-up.service';
import { DealRulesService } from './deal-rules.service';
import { DealOwnershipCleanupListener } from './deal-ownership-cleanup.listener';
import { DealAccountNameSyncListener } from './deal-account-name-sync.listener';
import { DEAL_IMPORT_QUEUE, DEAL_EXPORT_QUEUE } from './deals.constants';
import {
  ImportJobSchema,
  ImportJobSchemaClass,
} from '../common/import/import-job.schema';
import {
  UserSchema,
  UserSchemaClass,
} from '../users/infrastructure/persistence/document/entities/user.schema';
import {
  DealStageSchema,
  DealStageSchemaClass,
} from '../deal-settings/entities/deal-stage.schema';
import {
  DealSourceSchema,
  DealSourceSchemaClass,
} from '../deal-settings/entities/deal-source.schema';
import {
  AccountSchema,
  AccountSchemaClass,
} from '../accounts/infrastructure/persistence/document/entities/account.schema';
import {
  TicketSchema,
  TicketSchemaClass,
} from '../tickets/infrastructure/persistence/document/entities/ticket.schema';
import { DealSettingsModule } from '../deal-settings/deal-settings.module';
import { CrmSettingsModule } from '../crm-settings/crm-settings.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { TagsModule } from '../tags/tags.module';
import { AutomationOutboxModule } from '../automation-rules/events/automation-outbox.module';
import { ObjectManagerModule } from '../object-manager/object-manager.module';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { TasksModule } from '../tasks/tasks.module';

const workerProviders = isWorkerRuntime()
  ? [
      DealImportProcessor,
      DealExportProcessor,
      // Retention purge: the only path that hard-deletes, plus the cascade that keeps
      // related records from being orphaned by it. Worker-gated like every other cron —
      // an unconditional provider schedules it in every API replica too and makes the
      // Redis lock load-bearing for correctness rather than a safety net.
      DealPurgeService,
      // The follow-up sweep is a cron: worker-gated like every other one, so it
      // does not also schedule itself in each API replica.
      DealFollowUpService,
    ]
  : [];

@Module({
  imports: [
    // Supplies CustomFieldValueValidator so submitted `customFields` are checked
    // against the tenant's registry instead of being written as opaque Mixed.
    CustomFieldsModule,
    ObjectManagerModule,
    // Supplies TasksService so a due follow-up becomes a real Task, not only a
    // live broadcast an offline owner would never see.
    TasksModule,
    MongooseModule.forFeature([
      { name: DealSchemaClass.name, schema: DealSchema },
      { name: ImportJobSchemaClass.name, schema: ImportJobSchema },
      { name: UserSchemaClass.name, schema: UserSchema },
      { name: DealStageSchemaClass.name, schema: DealStageSchema },
      { name: DealSourceSchemaClass.name, schema: DealSourceSchema },
      { name: AccountSchemaClass.name, schema: AccountSchema },
      // Registered so `getLinkedTickets` reads through the model — and therefore
      // the tenant plugin — instead of a raw driver collection.
      { name: TicketSchemaClass.name, schema: TicketSchema },
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
    ActivityLogModule,
    TagsModule,
    AutomationOutboxModule,
    // Stage and pipeline resolution: the single authority on where a deal lands.
    DealSettingsModule,
    CrmSettingsModule,
  ],
  controllers: [DealsController],
  providers: [
    DealsService,
    DealRulesService,
    DealRepository,
    DealOwnershipCleanupListener,
    DealAccountNameSyncListener,
    ...workerProviders,
  ],
  exports: [DealsService, DealRepository],
})
export class DealsModule {}
