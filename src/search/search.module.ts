import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AuthorizationModule } from '../common/permissions/authorization.module';
import { ContactsModule } from '../contacts/contacts.module';
import { DealsModule } from '../deals/deals.module';
import { TasksModule } from '../tasks/tasks.module';
import { TicketsModule } from '../tickets/tickets.module';
import { GlobalSearchController } from './global-search.controller';
import { GlobalSearchService } from './global-search.service';
import { MongoSearchEngine } from './engines/mongo-search.engine';
import { OpenSearchEngine } from './engines/opensearch.engine';
import {
  MONGO_SEARCH_ENGINE,
  OPENSEARCH_SEARCH_ENGINE,
} from './engines/search-engine';
import { SearchEngineRouter } from './engines/search-engine.router';
import { ObservabilityModule } from '../observability/observability.module';

@Module({
  imports: [
    AuthorizationModule,
    ContactsModule,
    AccountsModule,
    DealsModule,
    TicketsModule,
    TasksModule,
    ObservabilityModule,
  ],
  controllers: [GlobalSearchController],
  providers: [
    GlobalSearchService,
    MongoSearchEngine,
    OpenSearchEngine,
    SearchEngineRouter,
    { provide: MONGO_SEARCH_ENGINE, useExisting: MongoSearchEngine },
    { provide: OPENSEARCH_SEARCH_ENGINE, useExisting: OpenSearchEngine },
  ],
  exports: [OpenSearchEngine],
})
export class SearchModule {}
