import { Injectable } from '@nestjs/common';
import { AccountsService } from '../../accounts/accounts.service';
import { ContactsService } from '../../contacts/contacts.service';
import { DealsService } from '../../deals/deals.service';
import { TasksService } from '../../tasks/tasks.service';
import { TicketsService } from '../../tickets/tickets.service';
import { rankSearchResult } from '../search-ranking';
import {
  EngineSearchRequest,
  EngineSearchResponse,
  SearchEngine,
} from './search-engine';

@Injectable()
export class MongoSearchEngine implements SearchEngine {
  readonly name = 'mongodb' as const;

  constructor(
    private readonly contacts: ContactsService,
    private readonly accounts: AccountsService,
    private readonly deals: DealsService,
    private readonly tickets: TicketsService,
    private readonly tasks: TasksService,
  ) {}

  async search(request: EngineSearchRequest): Promise<EngineSearchResponse> {
    const page = request.cursor ? Number(request.cursor) : 1;
    const response = await this.searchModule(request, page);
    return {
      data: (response.data ?? []).map((record: any) =>
        this.toResult(request.module, record, request.query),
      ),
      nextCursor: this.hasNextPage(response) ? String(page + 1) : null,
    };
  }

  private searchModule(request: EngineSearchRequest, page: number) {
    const params = {
      search: request.query,
      page,
      limit: request.limit,
    };
    switch (request.module) {
      case 'contacts':
        return this.contacts.findAll(params);
      case 'accounts':
        return this.accounts.findAll(params);
      case 'deals':
        return this.deals.findAll(params);
      case 'tickets':
        return this.tickets.findAll(params);
      case 'tasks':
        return this.tasks.findAll(params);
    }
  }

  private toResult(
    module: EngineSearchRequest['module'],
    record: any,
    query: string,
  ) {
    const id = String(record.id ?? record._id);
    const fields = this.resultFields(module, record);
    return {
      id,
      module,
      ...fields,
      href: `/${module}/${id}`,
      ...rankSearchResult(query, fields.title, fields.subtitle),
    };
  }

  private resultFields(module: EngineSearchRequest['module'], record: any) {
    switch (module) {
      case 'contacts':
        return {
          title:
            [record.firstName, record.lastName].filter(Boolean).join(' ') ||
            'Unnamed contact',
          subtitle: record.companyName || record.title,
        };
      case 'accounts':
        return {
          title: record.name || 'Unnamed account',
          subtitle: record.website || record.industry,
        };
      case 'deals':
        return {
          title: record.title || record.name || 'Unnamed deal',
          subtitle: record.accountName,
        };
      case 'tickets':
        return {
          title: record.subject || 'Untitled ticket',
          subtitle: record.ticketNumber,
        };
      case 'tasks':
        return {
          title: record.title || 'Untitled task',
          subtitle: record.description,
        };
    }
  }

  private hasNextPage(response: {
    hasNextPage?: boolean;
    currentPage?: number;
    totalPages?: number;
  }): boolean {
    if (typeof response.hasNextPage === 'boolean') return response.hasNextPage;
    return (
      typeof response.currentPage === 'number' &&
      typeof response.totalPages === 'number' &&
      response.currentPage < response.totalPages
    );
  }
}
