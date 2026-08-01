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

interface OpenSearchCursor {
  version: 2;
  sort: unknown[];
}

const PIT_KEEP_ALIVE = '2m';

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
    if (!!config.username !== !!config.password) {
      throw new Error(
        'OpenSearch username and password must either both be set or both be omitted',
      );
    }
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
    const cursor = this.decodeCursor(request.cursor);
    const openedPit = request.snapshotId ? null : await this.openPointInTime();
    const pitId = request.snapshotId ?? openedPit!;
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
      pit: { id: pitId, keep_alive: PIT_KEEP_ALIVE },
      ...(cursor ? { search_after: cursor.sort } : {}),
      _source: ['recordId', 'module', 'title', 'subtitle'],
    };

    let response: { data?: any };
    try {
      response = await this.client.post('/_search', body);
    } catch (error) {
      if (openedPit) await this.closePointInTime(openedPit);
      throw this.toEngineError(error);
    }

    const hits = (response.data?.hits?.hits ?? []) as SearchHit[];
    const currentPitId =
      typeof response.data?.pit_id === 'string' && response.data.pit_id
        ? response.data.pit_id
        : pitId;
    const hasNextPage = hits.length === request.limit && hits.at(-1)?.sort;
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
          // Keep this strictly monotonic with the `_score` used by
          // search_after. Re-ranking here used to let a hit from a later page
          // outrank an earlier one after GlobalSearchService merged modules.
          // Exact/phrase/prefix preferences already live in the query boosts;
          // the local lexical helper is retained only for safe highlights.
          score: relevance,
          highlights: ranked.highlights,
        };
      }),
      nextCursor: hasNextPage
        ? this.encodeCursor({
            version: 2,
            sort: hits.at(-1)!.sort!,
          })
        : null,
      snapshotId: currentPitId,
    };
  }

  async ping(): Promise<number> {
    const startedAt = Date.now();
    await this.client.get('/');
    return Date.now() - startedAt;
  }

  /** Age of the newest business record, not index replication lag. */
  async newestRecordAgeSeconds(): Promise<number | null> {
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
    const clauses: Record<string, unknown>[] = [
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
      {
        match: {
          'title.prefix': {
            query,
            boost: 3,
            minimum_should_match: '2<70%',
          },
        },
      },
      {
        match: {
          'subtitle.prefix': {
            query,
            boost: 1.5,
            minimum_should_match: '2<70%',
          },
        },
      },
      {
        match_bool_prefix: {
          searchText: {
            query,
            boost: 1,
            minimum_should_match: '2<70%',
          },
        },
      },
    ];
    const digits = query.replace(/\D+/g, '');
    if (/^[+\d\s().-]+$/.test(query) && digits.length >= 4) {
      clauses.push({
        term: { phoneSuffixes: { value: digits.slice(-20), boost: 4 } },
      });
    }
    return clauses;
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
      // Hidden-state parity with the MongoDB read paths. `accounts` excludes
      // archived rows from every list; without this clause turning the gateway
      // on brought them back into search, which reads to a user as the product
      // ignoring something they deliberately put away. Harmless for modules
      // that never set the flag.
      { bool: { must_not: [{ term: { flags: 'archived' } }] } },
    ];
    if (request.scope.restrictToOwnerUserId) {
      filters.push({
        term: { ownerId: request.scope.restrictToOwnerUserId },
      });
    }
    const owners = request.scope.visibleOwnerIds;
    if (Array.isArray(owners)) {
      const should: Record<string, unknown>[] = [];
      if (owners.length) should.push({ terms: { ownerId: owners } });
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
      filters.push(
        should.length
          ? { bool: { should, minimum_should_match: 1 } }
          : { match_none: {} },
      );
    }
    if (request.scope.abacFilter) {
      filters.push(mongoAuthorizationFilterToDsl(request.scope.abacFilter));
    }
    return filters;
  }

  private encodeCursor(cursor: OpenSearchCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeCursor(cursor?: string): OpenSearchCursor | undefined {
    if (!cursor) return undefined;
    try {
      const parsed = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      );
      if (
        parsed?.version !== 2 ||
        !Array.isArray(parsed.sort) ||
        parsed.sort.length !== 3
      ) {
        throw new Error();
      }
      return parsed;
    } catch {
      throw new BadRequestException('Invalid or stale search cursor');
    }
  }

  private async openPointInTime(): Promise<string> {
    try {
      const response = await this.client.post(
        `/${this.alias}/_search/point_in_time`,
        undefined,
        { params: { keep_alive: PIT_KEEP_ALIVE } },
      );
      const pitId = response.data?.pit_id;
      if (typeof pitId !== 'string' || !pitId) {
        throw new Error('OpenSearch returned an invalid PIT id');
      }
      return pitId;
    } catch (error) {
      throw this.toEngineError(error);
    }
  }

  async closeSnapshot(pitId: string): Promise<void> {
    await this.client
      .delete('/_search/point_in_time', { data: { pit_id: [pitId] } })
      .catch(() => undefined);
  }

  private closePointInTime(pitId: string): Promise<void> {
    return this.closeSnapshot(pitId);
  }
}
