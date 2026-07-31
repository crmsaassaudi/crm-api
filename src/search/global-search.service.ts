import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { ContactsService } from '../contacts/contacts.service';
import { AccountsService } from '../accounts/accounts.service';
import { DealsService } from '../deals/deals.service';
import { TicketsService } from '../tickets/tickets.service';
import { TasksService } from '../tasks/tasks.service';
import { AuthorizationService } from '../common/permissions/authorization.service';
import {
  GlobalSearchQueryDto,
  SEARCH_MODULES,
  SearchModule,
} from './dto/global-search-query.dto';
import { rankSearchResult, SearchHighlightRange } from './search-ranking';

interface CursorState {
  version: 1;
  fingerprint: string;
  pages: Partial<Record<SearchModule, number | null>>;
}

export interface GlobalSearchResult {
  id: string;
  module: SearchModule;
  title: string;
  subtitle?: string;
  href: string;
  score: number;
  highlights: {
    title?: SearchHighlightRange[];
    subtitle?: SearchHighlightRange[];
  };
}

interface ModuleSearchResponse {
  data?: any[];
  hasNextPage?: boolean;
  currentPage?: number;
  totalPages?: number;
}

@Injectable()
export class GlobalSearchService {
  private readonly logger = new Logger(GlobalSearchService.name);

  constructor(
    private readonly contacts: ContactsService,
    private readonly accounts: AccountsService,
    private readonly deals: DealsService,
    private readonly tickets: TicketsService,
    private readonly tasks: TasksService,
    private readonly authorization: AuthorizationService,
    private readonly cls: ClsService,
    private readonly events: EventEmitter2,
  ) {}

  async search(input: GlobalSearchQueryDto) {
    const startedAt = Date.now();
    const query = input.query.trim();
    const requestedModules = input.modules?.length
      ? input.modules
      : [...SEARCH_MODULES];
    const fingerprint = this.fingerprint(query, requestedModules);
    const cursor = this.decodeCursor(input.cursor, fingerprint);
    const allowedModules: SearchModule[] = [];
    const deniedModules: SearchModule[] = [];
    const results: GlobalSearchResult[] = [];
    const nextPages: CursorState['pages'] = { ...cursor.pages };

    for (const module of requestedModules) {
      const page = cursor.pages[module] ?? 1;
      if (page === null) continue;

      const decision = await this.authorize(module);
      if (!decision.allowed) {
        deniedModules.push(module);
        nextPages[module] = null;
        continue;
      }
      allowedModules.push(module);

      const previousAbac = this.cls.get('abacResourceFilter');
      this.cls.set('abacResourceFilter', {
        resource: module,
        filter: decision.resourceFilter ?? null,
      });
      try {
        const response = await this.searchModule(
          module,
          query,
          page,
          input.limitPerModule,
        );
        results.push(
          ...(response.data ?? []).map((record) =>
            this.toSearchResult(module, record, query),
          ),
        );
        nextPages[module] = this.hasNextPage(response) ? page + 1 : null;
      } finally {
        this.cls.set('abacResourceFilter', previousAbac);
      }
    }

    results.sort(
      (left, right) =>
        right.score - left.score ||
        left.module.localeCompare(right.module) ||
        left.title.localeCompare(right.title) ||
        left.id.localeCompare(right.id),
    );

    const hasNextPage = Object.values(nextPages).some(
      (page) => typeof page === 'number',
    );
    const durationMs = Date.now() - startedAt;
    const telemetry = {
      tenantId: this.cls.get<string>('tenantId'),
      userId: this.cls.get<string>('userId'),
      queryHash: this.queryHash(query),
      queryLength: query.length,
      requestedModules,
      allowedModules,
      deniedModules,
      resultCount: results.length,
      cursorUsed: Boolean(input.cursor),
      durationMs,
    };
    this.events.emit('search.executed', telemetry);
    this.logger.log(`Global search executed ${JSON.stringify(telemetry)}`);

    return {
      data: results,
      nextCursor: hasNextPage
        ? this.encodeCursor({
            version: 1,
            fingerprint,
            pages: nextPages,
          })
        : null,
      hasNextPage,
      meta: {
        queryHash: telemetry.queryHash,
        durationMs,
        allowedModules,
        deniedModules,
      },
    };
  }

  private async authorize(module: SearchModule) {
    const rawUserId = this.cls.get<string>('userId');
    const tenantId = this.cls.get<string>('tenantId');
    if (!rawUserId || !tenantId) {
      throw new UnauthorizedException();
    }
    return this.authorization.canPerformAction({
      rawUserId,
      tenantHint: tenantId,
      claims: this.cls.get('user'),
      rule: { action: 'view', resource: module },
    });
  }

  private searchModule(
    module: SearchModule,
    query: string,
    page: number,
    limit: number,
  ): Promise<ModuleSearchResponse> {
    const params = { search: query, page, limit };
    switch (module) {
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

  private toSearchResult(
    module: SearchModule,
    record: any,
    query: string,
  ): GlobalSearchResult {
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

  private resultFields(
    module: SearchModule,
    record: any,
  ): { title: string; subtitle?: string } {
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

  private hasNextPage(response: ModuleSearchResponse): boolean {
    if (typeof response.hasNextPage === 'boolean') return response.hasNextPage;
    return (
      typeof response.currentPage === 'number' &&
      typeof response.totalPages === 'number' &&
      response.currentPage < response.totalPages
    );
  }

  private fingerprint(query: string, modules: SearchModule[]): string {
    return this.queryHash(
      `${query.toLocaleLowerCase()}|${[...modules].sort().join(',')}`,
    );
  }

  private queryHash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }

  private encodeCursor(cursor: CursorState): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeCursor(
    raw: string | undefined,
    fingerprint: string,
  ): CursorState {
    if (!raw) return { version: 1, fingerprint, pages: {} };
    try {
      const parsed = JSON.parse(
        Buffer.from(raw, 'base64url').toString('utf8'),
      ) as CursorState;
      if (
        parsed.version !== 1 ||
        parsed.fingerprint !== fingerprint ||
        !parsed.pages ||
        Object.values(parsed.pages).some(
          (page) =>
            page !== null &&
            (!Number.isInteger(page) ||
              Number(page) < 1 ||
              Number(page) > 10_000),
        )
      ) {
        throw new Error('invalid cursor');
      }
      return parsed;
    } catch {
      throw new BadRequestException('Invalid or stale search cursor');
    }
  }
}
