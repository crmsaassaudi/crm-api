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
import { AccountsModule } from '../accounts/accounts.module';
import { DealsModule } from '../deals/deals.module';
import { ListViewsModule } from '../list-views/list-views.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { NotesModule } from '../notes/notes.module';
import { TasksModule } from '../tasks/tasks.module';
import { TicketsModule } from '../tickets/tickets.module';

import { ContactExportStorageService } from './contact-export-storage.service';
import { ContactExportProcessor } from './contact-export.processor';
import { ContactScoringService } from './contact-scoring.service';
import { isWorkerRuntime } from '../config/runtime-role';
import { CONTACT_EXPORT_QUEUE } from './contacts.constants';

const workerProviders = isWorkerRuntime()
  ? [ContactScoringService, ContactExportProcessor]
  : [];

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ContactSchemaClass.name, schema: ContactSchema },
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
    AccountsModule,
    DealsModule,
    ListViewsModule,
    ActivityLogModule,
    NotesModule,
    TasksModule,
    TicketsModule,

  ],
  controllers: [ContactsController],
  providers: [
    ContactsService,
    ContactRepository,
    ContactExportStorageService,
    ...workerProviders,
  ],
  exports: [ContactsService, ContactRepository],
})
export class ContactsModule {}
