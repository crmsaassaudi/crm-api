import {
  BadRequestException,
  Injectable,
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

@Injectable()
export class OpenSearchEngine implements SearchEngine {
  readonly name = 'opensearch' as const;
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
              multi_match: {
                query: request.query,
                fields: ['title^5', 'subtitle^2', 'searchText'],
                type: 'best_fields',
                fuzziness: 'AUTO',
                prefix_length: 1,
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

    try {
      const response = await this.client.post(`/${this.alias}/_search`, body);
      const hits = (response.data?.hits?.hits ?? []) as SearchHit[];
      return {
        data: hits.map((hit) => {
          const source = hit._source;
          const ranked = rankSearchResult(
            request.query,
            source.title,
            source.subtitle,
          );
          return {
            id: String(source.recordId),
            module: source.module,
            title: source.title,
            ...(source.subtitle ? { subtitle: source.subtitle } : {}),
            href: `/${source.module}/${source.recordId}`,
            score: Number(hit._score ?? ranked.score),
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
    } catch (error) {
      throw new ServiceUnavailableException('Search engine unavailable', {
        cause: error,
      });
    }
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

  private securityFilter(
    request: EngineSearchRequest,
  ): Record<string, unknown>[] {
    const filters: Record<string, unknown>[] = [
      { term: { tenantId: request.scope.tenantId } },
      { term: { module: request.module } },
    ];
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
