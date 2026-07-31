import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AuthorizationModule } from '../common/permissions/authorization.module';
import { ContactsModule } from '../contacts/contacts.module';
import { DealsModule } from '../deals/deals.module';
import { TasksModule } from '../tasks/tasks.module';
import { TicketsModule } from '../tickets/tickets.module';
import { GlobalSearchController } from './global-search.controller';
import { GlobalSearchService } from './global-search.service';

@Module({
  imports: [
    AuthorizationModule,
    ContactsModule,
    AccountsModule,
    DealsModule,
    TicketsModule,
    TasksModule,
  ],
  controllers: [GlobalSearchController],
  providers: [GlobalSearchService],
})
export class SearchModule {}
