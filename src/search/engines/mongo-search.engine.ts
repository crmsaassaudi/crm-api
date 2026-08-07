import { Injectable } from '@nestjs/common';
import { AccountsService } from '../../accounts/accounts.service';
import { ContactsService } from '../../contacts/contacts.service';
import { DealsService } from '../../deals/deals.service';
import { TasksService } from '../../tasks/tasks.service';
import { TicketsService } from '../../tickets/tickets.service';
import { ConversationRepository } from '../../omni-inbound/repositories/conversation.repository';
import { rankSearchResult } from '../search-ranking';
import { GlobalSearchResult } from '../global-search.types';
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
    // The repository rather than a service: `buildFilter` runs
    // `applyVisibilityScope`, so scope is enforced on the same path the inbox
    // uses. Going around it would mean a second copy of a security filter.
    private readonly conversations: ConversationRepository,
  ) {}

  /**
   * How many rows to pull per requested row before ranking.
   *
   * The bug this fixes: `findAll` sorts by `createdAt` descending, so asking it
   * for five rows returned the five most *recently created* matches — and only
   * then were they scored. A contact named exactly "Ahmed", created two years
   * ago, could never appear in a search for "Ahmed", no matter how well it
   * matched. The engine was not ranking badly; it was not ranking at all.
   *
   * Over-fetching and ranking the wider set is the smallest fix that makes the
   * top of the list mean something. Four is a judgement, not a measurement: it
   * is enough that an exact match outside the newest five is reachable, and
   * small enough that the cost stays bounded. It is affordable now only because
   * `searchKeys` made the underlying query index-backed; against the previous
   * collection scan, fetching four times as much would have been four times the
   * damage.
   */
  private static readonly CANDIDATE_FACTOR = 4;
  private static readonly MAX_CANDIDATES = 100;

  /**
   * Pages are served *within* a candidate window, not by re-fetching a wider
   * window each time.
   *
   * Simply over-fetching and slicing would break pagination: page 1 would drop
   * three quarters of what it read, and page 2 would fetch the *next* window
   * and never show them. So one repository page of `limit × 4` rows is ranked
   * once and then handed out four result pages at a time.
   *
   * The honest limitation: ranking is global within a window, not across the
   * whole result set — row 21 cannot outrank row 4. That is inherent to ranking
   * outside the database and is the right trade at this size. What it fixes is
   * the defect that mattered: the top of page one is now the best match rather
   * than the newest one.
   */
  async search(request: EngineSearchRequest): Promise<EngineSearchResponse> {
    const resultPage = Math.max(1, Number(request.cursor) || 1);
    const candidateLimit = Math.min(
      request.limit * MongoSearchEngine.CANDIDATE_FACTOR,
      MongoSearchEngine.MAX_CANDIDATES,
    );
    const pagesPerWindow = Math.max(
      1,
      Math.floor(candidateLimit / request.limit),
    );
    const windowPage = Math.floor((resultPage - 1) / pagesPerWindow) + 1;
    const offsetInWindow = ((resultPage - 1) % pagesPerWindow) * request.limit;

    const response = await this.searchModule(
      request,
      windowPage,
      candidateLimit,
    );
    const ranked: GlobalSearchResult[] = (response.data ?? []).map(
      (record: any) => this.toResult(request.module, record, request.query),
    );
    // Ties broken on id, so two identical requests return the same order
    // rather than whatever the driver happened to yield.
    ranked.sort(
      (left, right) =>
        right.score - left.score || left.id.localeCompare(right.id),
    );

    const data = ranked.slice(offsetInWindow, offsetInWindow + request.limit);
    // More to show either because this window has rows past the slice, or
    // because the repository says another window exists.
    const hasMore =
      offsetInWindow + request.limit < ranked.length ||
      this.hasNextPage(response);

    return {
      data,
      nextCursor: hasMore && data.length > 0 ? String(resultPage + 1) : null,
    };
  }

  private searchModule(
    request: EngineSearchRequest,
    page: number,
    limit: number,
  ) {
    const params = {
      search: request.query,
      page,
      limit,
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
      case 'conversations':
        return this.conversations.findPaginated(
          {
            tenantId: request.scope.tenantId,
            search: request.query,
            canSearchSensitive: request.scope.canSearchSensitive === true,
          },
          page,
          limit,
        );
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
          title: record.title || 'Unnamed deal',
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
      case 'conversations':
        return {
          title: record.customer?.name || 'Khách chưa định danh',
          // The channel, not the last message: a message body changes with
          // every reply, so a result would describe itself differently each
          // time it was found.
          subtitle: record.channelType,
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
