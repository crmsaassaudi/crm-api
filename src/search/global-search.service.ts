import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { AuthorizationService } from '../common/permissions/authorization.service';
import {
  GlobalSearchQueryDto,
  SEARCH_MODULES,
  SearchModule,
} from './dto/global-search-query.dto';
import { SearchEngineRouter } from './engines/search-engine.router';
import { GlobalSearchResult } from './global-search.types';
import { MetricsService } from '../observability/metrics.service';

interface CursorState {
  version: 2;
  fingerprint: string;
  modules: Partial<Record<SearchModule, string | null>>;
}

@Injectable()
export class GlobalSearchService {
  private readonly logger = new Logger(GlobalSearchService.name);

  constructor(
    private readonly authorization: AuthorizationService,
    private readonly cls: ClsService,
    private readonly events: EventEmitter2,
    private readonly router: SearchEngineRouter,
    private readonly metrics: MetricsService,
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
    const nextModules: CursorState['modules'] = { ...cursor.modules };
    let requestedEngine: 'mongodb' | 'opensearch' = 'mongodb';
    let actualEngine: 'mongodb' | 'opensearch' = 'mongodb';
    let fallbackUsed = false;
    let fallbackReason: string | undefined;

    const tenantId = this.cls.get<string>('tenantId');
    const userId = this.cls.get<string>('userId');
    if (!tenantId || !userId) throw new UnauthorizedException();

    for (const module of requestedModules) {
      if (cursor.modules[module] === null) continue;
      const decision = await this.authorize(module, tenantId, userId);
      if (!decision.allowed) {
        deniedModules.push(module);
        nextModules[module] = null;
        continue;
      }
      allowedModules.push(module);

      const previousAbac = this.cls.get('abacResourceFilter');
      this.cls.set('abacResourceFilter', {
        resource: module,
        filter: decision.resourceFilter ?? null,
      });
      try {
        const visibleOwnerIds = this.cls.get<string[] | null>(
          'visibleOwnerIds',
        );
        if (visibleOwnerIds === undefined) {
          throw new UnauthorizedException('Search data scope is unavailable');
        }
        const response = await this.router.search({
          module,
          query,
          limit: input.limitPerModule,
          cursor: cursor.modules[module] ?? undefined,
          scope: {
            tenantId,
            userId,
            visibleOwnerIds,
            visibleOrgUnitIds:
              this.cls.get<string[] | null>('visibleOrgUnitIds') ?? null,
            includeUnowned:
              this.cls.get<boolean>('includeUnownedInScope') === true,
            abacFilter: decision.resourceFilter,
          },
        });
        results.push(...response.data);
        nextModules[module] = response.nextCursor;
        requestedEngine = response.requestedEngine;
        actualEngine = response.actualEngine;
        fallbackUsed ||= response.fallbackUsed;
        fallbackReason ??= response.fallbackReason;
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
    const hasNextPage = Object.values(nextModules).some(
      (value) => typeof value === 'string',
    );
    const durationMs = Date.now() - startedAt;
    const telemetry = {
      tenantId,
      userId,
      queryHash: this.queryHash(query),
      queryLength: query.length,
      requestedModules,
      allowedModules,
      deniedModules,
      requestedEngine,
      actualEngine,
      fallbackUsed,
      ...(fallbackReason ? { fallbackReason } : {}),
      resultCount: results.length,
      cursorUsed: Boolean(input.cursor),
      durationMs,
    };
    this.events.emit('search.executed', telemetry);
    const metricLabels = {
      requested_engine: requestedEngine,
      actual_engine: actualEngine,
      fallback: String(fallbackUsed),
    };
    this.metrics.incrementCounter('crm_search_requests_total', metricLabels);
    this.metrics.incrementCounter(
      'crm_search_results_total',
      metricLabels,
      results.length,
    );
    this.metrics.incrementCounter(
      'crm_search_duration_ms_total',
      metricLabels,
      durationMs,
    );
    if (fallbackUsed) {
      this.metrics.incrementCounter('crm_search_fallback_total', {
        reason: fallbackReason ?? 'unknown',
      });
    }
    this.logger.log(`Global search executed ${JSON.stringify(telemetry)}`);

    return {
      data: results,
      nextCursor: hasNextPage
        ? this.encodeCursor({
            version: 2,
            fingerprint,
            modules: nextModules,
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

  private authorize(module: SearchModule, tenantId: string, userId: string) {
    return this.authorization.canPerformAction({
      rawUserId: userId,
      tenantHint: tenantId,
      claims: this.cls.get('user'),
      rule: { action: 'view', resource: module },
    });
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
    if (!raw) return { version: 2, fingerprint, modules: {} };
    try {
      const parsed = JSON.parse(
        Buffer.from(raw, 'base64url').toString('utf8'),
      ) as CursorState;
      if (
        parsed.version !== 2 ||
        parsed.fingerprint !== fingerprint ||
        !parsed.modules ||
        Object.values(parsed.modules).some(
          (value) =>
            value !== null &&
            (typeof value !== 'string' || value.length > 1_024),
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

export type { GlobalSearchResult } from './global-search.types';
