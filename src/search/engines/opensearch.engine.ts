import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { AllConfigType } from '../../config/config.type';
import { rankSearchResult } from '../search-ranking';
import {
  EngineSearchRequest,
  EngineSearchResponse,
  SearchEngine,
} from './search-engine';
import { mongoAuthorizationFilterToDsl } from './opensearch-filter';

interface SearchHit {
  _score?: number;
  sort?: unknown[];
  _source: {
    recordId: string;
    module: EngineSearchRequest['module'];
    title: string;
    subtitle?: string;
  };
}

/**
 * A rejected query and an unreachable cluster both used to surface as the same
 * anonymous `ServiceUnavailableException`, so a malformed request silently
 * demoted every search to MongoDB for as long as the defect went unnoticed.
 * The reason travels with the error and lands on the fallback metric.
 */
export class OpenSearchQueryException extends ServiceUnavailableException {
  constructor(
    readonly reason: string,
    cause: unknown,
  ) {
    super('Search engine unavailable', { cause });
  }
}

/**
 * BM25 has no upper bound, while the MongoDB engine emits 0..1. Merging both
 * into one list ordered every OpenSearch hit above every MongoDB hit whenever
 * a single module fell back. Saturating puts them on one scale without
 * depending on the page's maximum, which `search_after` does not preserve.
 */
const SCORE_SATURATION = 6;
const saturate = (score: number): number => score / (score + SCORE_SATURATION);

@Injectable()
export class OpenSearchEngine implements SearchEngine {
  readonly name = 'opensearch' as const;
  private readonly logger = new Logger(OpenSearchEngine.name);
  private readonly client: AxiosInstance;
  private readonly alias: string;

  constructor(configService: ConfigService<AllConfigType>) {
    const config = configService.getOrThrow('opensearch', { infer: true });
    this.alias = `${config.indexPrefix}-global-search`;
    this.client = axios.create({
      baseURL: config.node.replace(/\/+$/, ''),
      timeout: config.requestTimeoutMs,
      auth:
        config.username && config.password
          ? { username: config.username, password: config.password }
          : undefined,
      headers: { 'content-type': 'application/json' },
    });
  }

  async search(request: EngineSearchRequest): Promise<EngineSearchResponse> {
    if (!request.scope.tenantId || !request.scope.userId) {
      throw new UnauthorizedException();
    }
    const filter = this.securityFilter(request);
    const searchAfter = this.decodeCursor(request.cursor);
    const body = {
      size: request.limit,
      track_total_hits: false,
      query: {
        bool: {
          must: [
            {
              bool: {
                should: this.matchClauses(request.query),
                minimum_should_match: 1,
              },
            },
          ],
          filter,
        },
      },
      sort: [{ _score: 'desc' }, { updatedAt: 'desc' }, { recordId: 'asc' }],
      ...(searchAfter ? { search_after: searchAfter } : {}),
      _source: ['recordId', 'module', 'title', 'subtitle'],
    };

    let response: { data?: any };
    try {
      response = await this.client.post(`/${this.alias}/_search`, body);
    } catch (error) {
      throw this.toEngineError(error);
    }

    const hits = (response.data?.hits?.hits ?? []) as SearchHit[];
    return {
      data: hits.map((hit) => {
        const source = hit._source;
        const ranked = rankSearchResult(
          request.query,
          source.title,
          source.subtitle,
        );
        const relevance = saturate(Number(hit._score ?? 0));
        return {
          id: String(source.recordId),
          module: source.module,
          title: source.title,
          ...(source.subtitle ? { subtitle: source.subtitle } : {}),
          href: `/${source.module}/${source.recordId}`,
          // Engine relevance dominates; the lexical rank keeps an exact
          // prefix match ahead of a fuzzy one at comparable BM25 scores.
          score: Number((relevance * 0.75 + ranked.score * 0.25).toFixed(4)),
          highlights: ranked.highlights,
        };
      }),
      nextCursor:
        hits.length === request.limit && hits.at(-1)?.sort
          ? Buffer.from(JSON.stringify(hits.at(-1)!.sort), 'utf8').toString(
              'base64url',
            )
          : null,
    };
  }

  async ping(): Promise<number> {
    const startedAt = Date.now();
    await this.client.get('/');
    return Date.now() - startedAt;
  }

  async freshnessAgeSeconds(): Promise<number | null> {
    const response = await this.client.post(`/${this.alias}/_search`, {
      size: 0,
      aggs: { latest_update: { max: { field: 'updatedAt' } } },
    });
    const timestamp = response.data?.aggregations?.latest_update?.value;
    return typeof timestamp === 'number'
      ? Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
      : null;
  }

  /**
   * `fuzziness: AUTO` alone needs a whole word — "ngu" is three edits from
   * "nguyen" — so the global search box returned nothing until the user
   * finished typing. The edge n-gram and prefix clauses are what make it
   * behave like a search box; `minimum_should_match` keeps a multi-word query
   * from matching every record that happens to share one term.
   */
  private matchClauses(query: string): Record<string, unknown>[] {
    return [
      {
        multi_match: {
          query,
          fields: ['title^5', 'subtitle^2', 'searchText'],
          type: 'best_fields',
          fuzziness: 'AUTO',
          prefix_length: 1,
          minimum_should_match: '2<70%',
        },
      },
      { match_phrase: { title: { query, boost: 6 } } },
      { match: { 'title.prefix': { query, boost: 3 } } },
      { match: { 'subtitle.prefix': { query, boost: 1.5 } } },
      { match_bool_prefix: { searchText: { query, boost: 1 } } },
    ];
  }

  private toEngineError(error: unknown): OpenSearchQueryException {
    const status = (error as any)?.response?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // Deterministic: the cluster is fine and rejected what we sent. Falling
      // back keeps the user working, but this is a defect and has to be loud.
      this.logger.error(
        `OpenSearch rejected the search request (${status}): ${JSON.stringify(
          (error as any)?.response?.data?.error ?? {},
        )}`,
      );
      return new OpenSearchQueryException(`rejected_${status}`, error);
    }
    if (typeof status === 'number') {
      return new OpenSearchQueryException(`unavailable_${status}`, error);
    }
    const code = (error as any)?.code;
    return new OpenSearchQueryException(
      code === 'ECONNABORTED' ? 'timeout' : 'unreachable',
      error,
    );
  }

  private securityFilter(
    request: EngineSearchRequest,
  ): Record<string, unknown>[] {
    const filters: Record<string, unknown>[] = [
      { term: { tenantId: request.scope.tenantId } },
      { term: { module: request.module } },
    ];
    if (request.scope.restrictToOwnerUserId) {
      filters.push({
        term: { ownerId: request.scope.restrictToOwnerUserId },
      });
    }
    const owners = request.scope.visibleOwnerIds;
    if (Array.isArray(owners)) {
      const should: Record<string, unknown>[] = [
        { terms: { ownerId: owners } },
      ];
      if (request.scope.includeUnowned) {
        should.push({ bool: { must_not: [{ exists: { field: 'ownerId' } }] } });
      }
      if (
        Array.isArray(request.scope.visibleOrgUnitIds) &&
        request.scope.visibleOrgUnitIds.length
      ) {
        should.push({
          terms: { orgUnitId: request.scope.visibleOrgUnitIds },
        });
      }
      filters.push({ bool: { should, minimum_should_match: 1 } });
    }
    if (request.scope.abacFilter) {
      filters.push(mongoAuthorizationFilterToDsl(request.scope.abacFilter));
    }
    return filters;
  }

  private decodeCursor(cursor?: string): unknown[] | undefined {
    if (!cursor) return undefined;
    try {
      const parsed = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      );
      if (!Array.isArray(parsed) || parsed.length !== 3) throw new Error();
      return parsed;
    } catch {
      throw new BadRequestException('Invalid or stale search cursor');
    }
  }
}
