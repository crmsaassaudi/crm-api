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
import { PermissionResource } from '../common/permissions/permission.constants';
import {
  GlobalSearchQueryDto,
  SEARCH_MODULES,
  SearchModule,
} from './dto/global-search-query.dto';
import { SearchEngineRouter } from './engines/search-engine.router';
import { decodeEngineCursor } from './engines/engine-cursor';
import { GlobalSearchResult } from './global-search.types';
import { MetricsService } from '../observability/metrics.service';
import { CrmSettingsService } from '../crm-settings/crm-settings.service';
import {
  PiiSearchPolicy,
  looksLikeProtectedValue,
} from '../common/search/pii-search.policy';

/**
 * The permission resource a search module is governed by.
 *
 * Module names and permission resources were the same string for the first
 * five modules, so the code used one for the other. `conversations` is where
 * that stops: omni permissions are keyed on `omni_channel`, and passing the
 * module name would have asked the PDP about a resource that does not exist.
 *
 * A resource the PDP does not know is not a resource that fails open here — the
 * decision would simply be denied — but it would have shown up as "the search
 * box never returns conversations", which is indistinguishable from the feature
 * not working and much harder to trace than a map.
 */
const PERMISSION_RESOURCE: Record<SearchModule, PermissionResource> = {
  contacts: 'contacts',
  accounts: 'accounts',
  deals: 'deals',
  tickets: 'tickets',
  tasks: 'tasks',
  conversations: 'omni_channel',
};

const permissionResourceFor = (module: SearchModule): PermissionResource =>
  PERMISSION_RESOURCE[module];

interface CursorState {
  version: 3;
  fingerprint: string;
  modules: Partial<Record<SearchModule, string | null>>;
  openSearchPitId?: string;
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
    private readonly settings: CrmSettingsService,
    private readonly piiSearch: PiiSearchPolicy,
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
    /** Modules whose pagination restarted because the engine changed. */
    const restartedModules: SearchModule[] = [];
    const results: GlobalSearchResult[] = [];
    const nextModules: CursorState['modules'] = { ...cursor.modules };
    let openSearchPitId = cursor.openSearchPitId;
    let requestedEngine: 'mongodb' | 'opensearch' = 'mongodb';
    let fallbackUsed = false;
    let fallbackReason: string | undefined;
    /** Which engine actually answered each module, so nothing has to guess. */
    const engineByModule: Partial<
      Record<SearchModule, 'mongodb' | 'opensearch'>
    > = {};
    const degradedModules: SearchModule[] = [];
    let degraded = false;
    let degradedSemantics: string | undefined;

    const tenantId = this.cls.get<string>('tenantId');
    const userId = this.cls.get<string>('userId');
    if (!tenantId || !userId) throw new UnauthorizedException();

    const restrictOwnContacts = await this.restrictOwnContacts();
    // Resolved once for the whole request, and only when the term is shaped
    // like a protected value — an ordinary name search costs no permission
    // check and writes no audit line.
    const canSearchSensitive = looksLikeProtectedValue(query)
      ? await this.resolveSensitiveSearch(query)
      : false;

    try {
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
          resource: permissionResourceFor(module),
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
            // Per module, not per request. The OpenSearch index holds five
            // modules; conversations is not one of them, so routing that
            // branch with the rest would make it return nothing on exactly the
            // tenants that were switched to OpenSearch — enabling the engine
            // for a VIP tenant would take a feature away.
            capability:
              module === 'conversations'
                ? 'conversation_search'
                : 'global_search',
            module,
            query,
            limit: input.limitPerModule,
            cursor: cursor.modules[module] ?? undefined,
            ...(openSearchPitId ? { snapshotId: openSearchPitId } : {}),
            scope: {
              tenantId,
              userId,
              visibleOwnerIds,
              visibleOrgUnitIds:
                this.cls.get<string[] | null>('visibleOrgUnitIds') ?? null,
              includeUnowned:
                this.cls.get<boolean>('includeUnownedInScope') === true,
              abacFilter: decision.resourceFilter,
              restrictToOwnerUserId:
                module === 'contacts' && restrictOwnContacts ? userId : null,
              canSearchSensitive,
            },
          });
          results.push(...response.data);
          nextModules[module] = response.nextCursor;
          if (response.actualEngine === 'opensearch' && response.snapshotId) {
            openSearchPitId = response.snapshotId;
          }
          if (response.cursorReset) restartedModules.push(module);
          // Recorded per module, not overwritten. The previous assignment ran
          // inside this loop, so a mixed response reported whichever engine
          // happened to serve the *last* module — and the metric labelled by
          // that value is the one used to decide whether OpenSearch is worth
          // its bill.
          engineByModule[module] = response.actualEngine;
          requestedEngine = response.requestedEngine;
          fallbackUsed ||= response.fallbackUsed;
          fallbackReason ??= response.fallbackReason;
          if (response.degraded) {
            degraded = true;
            degradedSemantics ??= response.degradedSemantics;
            degradedModules.push(module);
          }
        } finally {
          this.cls.set('abacResourceFilter', previousAbac);
        }
      }
    } catch (error) {
      if (openSearchPitId) {
        await this.router.closeOpenSearchSnapshot(openSearchPitId);
      }
      throw error;
    }

    // One request can be served by both engines — the router is consulted per
    // module — and their scores are not the same quantity: MongoDB's heuristic
    // yields a handful of discrete values (`search-ranking.ts`) while OpenSearch
    // yields `bm25/(bm25+6)`. Ordering one against the other produces a ranking
    // that means nothing, and systematically favours whichever scale happens to
    // run higher. So a mixed response is grouped by module and ranked within each
    // group, where the comparison is between like and like.
    const enginesUsed = [...new Set(Object.values(engineByModule))];
    const scoresAreComparable = enginesUsed.length <= 1;
    results.sort(
      (left, right) =>
        (scoresAreComparable
          ? right.score - left.score || left.module.localeCompare(right.module)
          : left.module.localeCompare(right.module) ||
            right.score - left.score) ||
        left.title.localeCompare(right.title) ||
        left.id.localeCompare(right.id),
    );
    const hasNextPage = Object.values(nextModules).some(
      (value) => typeof value === 'string',
    );
    const hasOpenSearchNextPage = Object.values(nextModules).some((value) => {
      if (typeof value !== 'string') return false;
      return decodeEngineCursor(value)?.engine === 'opensearch';
    });
    if (openSearchPitId && !hasOpenSearchNextPage) {
      await this.router.closeOpenSearchSnapshot(openSearchPitId);
      openSearchPitId = undefined;
    }
    const durationMs = Date.now() - startedAt;
    // Never collapsed to a single engine name: that is how the dashboards came to
    // disagree with what actually happened.
    const actualEngine: 'mongodb' | 'opensearch' | 'mixed' =
      enginesUsed.length > 1 ? 'mixed' : (enginesUsed[0] ?? 'mongodb');
    const telemetry = {
      tenantId,
      userId,
      queryHash: this.queryHash(query),
      queryLength: query.length,
      requestedModules,
      allowedModules,
      deniedModules,
      restartedModules,
      requestedEngine,
      actualEngine,
      engineByModule,
      fallbackUsed,
      degraded,
      degradedModules,
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
      degraded: String(degraded),
    };
    this.metrics.incrementCounter('crm_search_requests_total', metricLabels);
    if (results.length === 0) {
      // Zero-result rate is the one number that says whether search is any
      // good, and nothing measured it: `search.executed` was emitted and no
      // listener existed. A search box that quietly returns nothing looks
      // identical, from the outside, to a search box nobody uses.
      this.metrics.incrementCounter('crm_search_zero_results_total', {
        modules: allowedModules.join(',') || 'none',
      });
    }
    this.metrics.incrementCounter(
      'crm_search_results_total',
      metricLabels,
      results.length,
    );
    // Only the histogram can answer "what is p95", which is the question the
    // latency budget is written in. A companion counter was carried alongside
    // it to keep dashboards from going blank across the cutover — there has
    // been no cutover, nothing queries it, and a series that can only ever
    // yield a mean is worse than no series when someone reaches for it during
    // an incident.
    this.metrics.observeHistogram(
      'crm_search_duration_ms',
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
            version: 3,
            fingerprint,
            modules: nextModules,
            ...(openSearchPitId ? { openSearchPitId } : {}),
          })
        : null,
      hasNextPage,
      meta: {
        queryHash: telemetry.queryHash,
        durationMs,
        allowedModules,
        deniedModules,
        // The capability's owning engine did not serve these modules, so the
        // answer is narrower and ordered differently than the search box
        // promises. The router knew this all along; until now it was computed
        // and thrown away, which made a degraded answer indistinguishable from
        // a wrong one.
        degraded,
        ...(degradedModules.length ? { degradedModules } : {}),
        ...(degraded && degradedSemantics ? { degradedSemantics } : {}),
        engineByModule,
        // The search engine changed between two pages, so these modules were
        // served from their first page again. The client can tell the user why
        // it is seeing rows it already scrolled past.
        ...(restartedModules.length ? { restartedModules } : {}),
      },
    };
  }

  /**
   * The contact repository narrows list queries to the caller's own records
   * when the tenant sets `data_access_policy.restrict_own_contacts`. The
   * OpenSearch index knows nothing about that setting, so it has to be carried
   * into the engine scope — otherwise turning OpenSearch on quietly widens
   * what a restricted user can find.
   */
  private async restrictOwnContacts(): Promise<boolean> {
    try {
      const policy = await this.settings.getSetting('data_access_policy');
      return (
        (policy as { restrict_own_contacts?: boolean })
          ?.restrict_own_contacts === true
      );
    } catch (error) {
      // Fail closed: an unreadable policy must not widen visibility.
      this.logger.error(
        `Could not read data_access_policy; restricting contact search to the caller: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return true;
    }
  }

  /**
   * Whether a phone- or e-mail-shaped query may be matched against the values
   * field masking hides.
   *
   * The global search box was the widest instance of the reverse-lookup gap:
   * one field, five modules, and no permission check between a masked value
   * and the name of the person it belongs to.
   */
  private async resolveSensitiveSearch(query: string): Promise<boolean> {
    const allowed = await this.piiSearch.canSearchSensitive('contacts');
    if (!allowed) this.piiSearch.recordDeniedLookup('contacts', query);
    return allowed;
  }

  private authorize(module: SearchModule, tenantId: string, userId: string) {
    return this.authorization.canPerformAction({
      rawUserId: userId,
      tenantHint: tenantId,
      claims: this.cls.get('user'),
      rule: { action: 'view', resource: permissionResourceFor(module) },
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
    if (!raw) return { version: 3, fingerprint, modules: {} };
    try {
      const parsed = JSON.parse(
        Buffer.from(raw, 'base64url').toString('utf8'),
      ) as CursorState;
      if (
        parsed.version !== 3 ||
        parsed.fingerprint !== fingerprint ||
        !parsed.modules ||
        (parsed.openSearchPitId !== undefined &&
          (typeof parsed.openSearchPitId !== 'string' ||
            !parsed.openSearchPitId ||
            parsed.openSearchPitId.length > 4_096)) ||
        Object.values(parsed.modules).some(
          (value) =>
            value !== null &&
            (typeof value !== 'string' || value.length > 4_096),
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
