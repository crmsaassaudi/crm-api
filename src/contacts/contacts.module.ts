import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
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
import { AuditLogModule } from '../audit-log/audit-log.module';
import { ContactExportStorageService } from './contact-export-storage.service';
import { ContactScoringService } from './contact-scoring.service';
import { isWorkerRuntime } from '../config/runtime-role';
import { ContactSettingsModule } from '../contact-settings/contact-settings.module';

const workerProviders = isWorkerRuntime() ? [ContactScoringService] : [];

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ContactSchemaClass.name, schema: ContactSchema },
    ]),
    AccountsModule,
    DealsModule,
    ListViewsModule,
    ActivityLogModule,
    NotesModule,
    TasksModule,
    TicketsModule,
    AuditLogModule,
    ContactSettingsModule,
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
