import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { ContactRepository } from './infrastructure/persistence/document/repositories/contact.repository';
import {
  ContactSchema,
  ContactSchemaClass,
} from './infrastructure/persistence/document/entities/contact.schema';
import {
  ImportJobSchema,
  ImportJobSchemaClass,
} from './infrastructure/persistence/document/entities/import-job.schema';
import {
  UserSchema,
  UserSchemaClass,
} from '../users/infrastructure/persistence/document/entities/user.schema';
import { AccountsModule } from '../accounts/accounts.module';
import { DealsModule } from '../deals/deals.module';
import { ListViewsModule } from '../list-views/list-views.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { NotesModule } from '../notes/notes.module';
import { TasksModule } from '../tasks/tasks.module';
import { TicketsModule } from '../tickets/tickets.module';

import { ContactExportStorageService } from './contact-export-storage.service';
import { ContactExportProcessor } from './contact-export.processor';
import { ContactImportProcessor } from './contact-import.processor';
import { ContactImportReportService } from './contact-import-report.service';
import { ContactScoringService } from './contact-scoring.service';
import { ContactPurgeService } from './contact-purge.service';
import { ContactMergeService } from './merge/contact-merge.service';
import { ContactTimelineService } from './timeline/contact-timeline.service';
import { ContactRelationsService } from './relations/contact-relations.service';
import { ContactIdentitySyncService } from './identities/contact-identity-sync.service';
import { ContactIdentityDriftService } from './identities/contact-identity-drift.service';
import {
  ContactIdentitySchema,
  ContactIdentitySchemaClass,
} from './identities/contact-identity.schema';
import {
  ContactRelationSchema,
  ContactRelationSchemaClass,
} from './relations/contact-relation.schema';
import {
  AccountContactRelationSchema,
  AccountContactRelationSchemaClass,
} from './relations/account-contact-relation.schema';
import {
  ContactMergeSchema,
  ContactMergeSchemaClass,
} from './merge/contact-merge.schema';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { TagsModule } from '../tags/tags.module';
import { isWorkerRuntime } from '../config/runtime-role';
import {
  CONTACT_EXPORT_QUEUE,
  CONTACT_IMPORT_QUEUE,
} from './contacts.constants';
import { AutomationOutboxModule } from '../automation-rules/events/automation-outbox.module';
import {
  ContactStageTransitionSchema,
  ContactStageTransitionSchemaClass,
} from './lifecycle/contact-stage-transition.schema';
import { ContactStageTransitionListener } from './lifecycle/contact-stage-transition.listener';

const workerProviders = isWorkerRuntime()
  ? [
      ContactScoringService,
      // Retention purge: the only path that hard-deletes a contact, and the
      // cascade that keeps related records from being orphaned by it.
      ContactPurgeService,
      // The identity projection is non-throwing by design, so drift is a normal
      // operating condition. This is what notices.
      ContactIdentityDriftService,
      ContactExportProcessor,
      ContactImportProcessor,
      ContactImportReportService,
    ]
  : [];

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ContactSchemaClass.name, schema: ContactSchema },
      { name: ImportJobSchemaClass.name, schema: ImportJobSchema },
      { name: UserSchemaClass.name, schema: UserSchema },
      { name: ContactMergeSchemaClass.name, schema: ContactMergeSchema },
      {
        name: ContactStageTransitionSchemaClass.name,
        schema: ContactStageTransitionSchema,
      },
      {
        name: ContactRelationSchemaClass.name,
        schema: ContactRelationSchema,
      },
      {
        name: AccountContactRelationSchemaClass.name,
        schema: AccountContactRelationSchema,
      },
      {
        name: ContactIdentitySchemaClass.name,
        schema: ContactIdentitySchema,
      },
    ]),
    BullModule.registerQueue({
      name: CONTACT_EXPORT_QUEUE,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    }),
    BullBoardModule.forFeature({
      name: CONTACT_EXPORT_QUEUE,
      adapter: BullMQAdapter,
    }),
    BullModule.registerQueue({
      name: CONTACT_IMPORT_QUEUE,
      defaultJobOptions: {
        // Same-job retries resume from a transactionally persisted batch
        // checkpoint and finish any pending identity projection first.
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 50,
        removeOnFail: 200,
      },
    }),
    BullBoardModule.forFeature({
      name: CONTACT_IMPORT_QUEUE,
      adapter: BullMQAdapter,
    }),
    AccountsModule,
    DealsModule,
    ListViewsModule,
    ActivityLogModule,
    NotesModule,
    TasksModule,
    TicketsModule,
    AutomationOutboxModule,
    // Supplies CustomFieldValueValidator so submitted `customFields` are checked
    // against the tenant's registry instead of being written as opaque Mixed,
    // and CustomFieldsService so `customFields.<key>` filters can be validated
    // against that same registry.
    CustomFieldsModule,
    // `contact.tags[]` stores tag IDs; bulk-tagging validates them against the
    // catalogue rather than writing whatever strings it was handed.
    TagsModule,
  ],
  controllers: [ContactsController],
  providers: [
    ContactsService,
    ContactRepository,
    ContactExportStorageService,
    // Merge reaches other collections through the shared Mongoose connection
    // rather than by importing their modules — see contact-references.registry.
    ContactMergeService,
    // Same raw-connection approach as merge, for the same reason: fanning in
    // notes/tickets/deals/tasks/conversations by injecting their modules would
    // recreate the dependency cycles ContactsModule avoids.
    ContactTimelineService,
    ContactRelationsService,
    ContactIdentitySyncService,
    ContactStageTransitionListener,
    ...workerProviders,
  ],
  exports: [
    ContactsService,
    ContactRepository,
    ContactMergeService,
    // The account detail page asks "who works here?" through this.
    ContactRelationsService,
    // The omni resolver and the livechat enrichment both need identity lookup.
    ContactIdentitySyncService,
  ],
})
export class ContactsModule {}
