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

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ContactSchemaClass.name, schema: ContactSchema },
    ]),
    AccountsModule,
    DealsModule,
    ListViewsModule,
  ],
  controllers: [ContactsController],
  providers: [ContactsService, ContactRepository],
  exports: [ContactsService, ContactRepository],
})
export class ContactsModule {}
