import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AllConfigType } from '../../config/config.type';
import {
  EngineSearchRequest,
  EngineSearchResponse,
  MONGO_SEARCH_ENGINE,
  OPENSEARCH_SEARCH_ENGINE,
  SearchEngine,
} from './search-engine';
import {
  AuthorizationFilterException,
  IndexFilterUnsupportedException,
} from './opensearch-filter';
import { MetricsService } from '../../observability/metrics.service';
import { decodeEngineCursor, encodeEngineCursor } from './engine-cursor';
import {
  CapabilityPlan,
  SearchCapabilityName,
  resolveCapability,
} from '../capabilities/search-capabilities';

export interface RoutedSearchResponse extends EngineSearchResponse {
  requestedEngine: SearchEngine['name'];
  actualEngine: SearchEngine['name'];
  fallbackUsed: boolean;
  fallbackReason?: string;
  /**
   * The capability's owning engine did not serve this request, so the answer is
   * weaker than the capability promises. It travels all the way to the client:
   * a degradation nobody is told about is indistinguishable from a wrong
   * answer.
   */
  degraded: boolean;
  degradedSemantics?: string;
  /**
   * The caller's cursor belonged to the other engine, so this module restarted
   * at its first page. Surfaced so the response can say so rather than let the
   * duplicate page look like fresh results.
   */
  cursorReset: boolean;
}

/** Consecutive engine failures before OpenSearch is taken out of rotation. */
const BREAKER_THRESHOLD = 5;
/** How long it stays out before one request is allowed through to probe it. */
const BREAKER_COOLDOWN_MS = 30_000;

interface BreakerState {
  consecutiveFailures: number;
  openUntil: number;
}

@Injectable()
export class SearchEngineRouter {
  private readonly logger = new Logger(SearchEngineRouter.name);
  /**
   * Keyed by capability, not shared across the process. A heavy capability
   * timing out used to open the breaker for a light one that was working
   * perfectly well, because both went through the same counter.
   */
  private readonly breakers = new Map<SearchCapabilityName, BreakerState>();

  constructor(
    private readonly configService: ConfigService<AllConfigType>,
    @Inject(MONGO_SEARCH_ENGINE) private readonly mongo: SearchEngine,
    @Inject(OPENSEARCH_SEARCH_ENGINE) private readonly openSearch: SearchEngine,
    private readonly events: EventEmitter2,
    private readonly metrics: MetricsService,
  ) {}

  async search(request: EngineSearchRequest): Promise<RoutedSearchResponse> {
    const config = this.configService.getOrThrow('opensearch', { infer: true });
    const plan = resolveCapability(request.capability, {
      openSearchEnabled: config.enabled,
      overrides: config.capabilityOverrides ?? {},
    });

    if (plan.disabled) {
      // The capability is switched off, either by an operator or because its
      // owner is unavailable and MongoDB has no index-backed path for it. An
      // unavailable feature is recoverable; answering it with a scan aimed at
      // the primary is how one outage becomes every outage.
      this.metrics.incrementCounter('crm_search_capability_disabled_total', {
        capability: request.capability,
        reason: plan.reason ?? 'unknown',
      });
      throw new ServiceUnavailableException(
        `Search capability "${request.capability}" is unavailable (${plan.reason ?? 'disabled'})`,
      );
    }

    if (plan.engine === 'mongodb') {
      // Configured to run here. Not a fallback and not a degradation — the
      // configuration is the promise, and it is being kept.
      return this.serve('mongodb', request, {
        requestedEngine: 'mongodb',
        actualEngine: 'mongodb',
        fallbackUsed: false,
        degraded: false,
      });
    }

    // While OpenSearch is known to be down, every module of every keystroke
    // used to burn its full timeout before falling back — five extra text
    // queries per request aimed at the primary, at exactly the wrong moment.
    if (this.breakerOpen(request.capability)) {
      return this.unavailable(request, plan, 'circuit_open', config);
    }

    try {
      const response = await this.serve('opensearch', request, {
        requestedEngine: 'opensearch',
        actualEngine: 'opensearch',
        fallbackUsed: false,
        degraded: false,
      });
      this.recordSuccess(request.capability);
      return response;
    } catch (error) {
      if (error instanceof IndexFilterUnsupportedException) {
        // Not an outage and not a refusal: the policy is enforceable, just not
        // by this index. MongoDB holds every field, so it answers this module —
        // without counting towards the breaker, since retrying OpenSearch with
        // the same policy would fail identically.
        this.metrics.incrementCounter('crm_search_engine_errors_total', {
          engine: 'opensearch',
          reason: 'filter_unsupported',
        });
        this.logger.warn(
          `Authorization predicate for ${request.module} cannot be expressed in the index (${error.message}); serving it from MongoDB`,
        );
        return this.unavailable(request, plan, 'filter_unsupported', config, {
          rethrow: error,
        });
      }
      if (
        error instanceof AuthorizationFilterException ||
        error instanceof BadRequestException ||
        error instanceof UnauthorizedException ||
        error instanceof ForbiddenException
      ) {
        // A refused authorization predicate or a bad cursor is the caller's
        // answer, not an engine outage: it must not trip the breaker and must
        // not be quietly answered by a different engine.
        this.metrics.incrementCounter('crm_search_engine_errors_total', {
          engine: 'opensearch',
          reason: error.constructor.name,
        });
        throw error;
      }

      const reason =
        (error as { reason?: string })?.reason ??
        (error instanceof Error ? error.constructor.name : 'UnknownError');
      this.metrics.incrementCounter('crm_search_engine_errors_total', {
        engine: 'opensearch',
        reason,
      });
      this.recordFailure(request.capability, reason);
      return this.unavailable(request, plan, reason, config, {
        rethrow: error,
      });
    }
  }

  async closeOpenSearchSnapshot(snapshotId: string): Promise<void> {
    await this.openSearch.closeSnapshot?.(snapshotId);
  }

  /**
   * The owning engine could not answer. What happens next is the capability's
   * declared policy, not a global flag — `degrade` only where MongoDB has an
   * index-backed path, `off` where its only option would be a scan.
   */
  private async unavailable(
    request: EngineSearchRequest,
    plan: CapabilityPlan,
    reason: string,
    config: { fallbackToMongoDb: boolean },
    options: { rethrow?: unknown } = {},
  ): Promise<RoutedSearchResponse> {
    // A deployment that explicitly turned the legacy flag off asked to fail
    // closed. That is still narrowing, so it is still honoured.
    const allowed = plan.policy === 'degrade' && config.fallbackToMongoDb;
    if (!allowed) {
      this.metrics.incrementCounter('crm_search_capability_disabled_total', {
        capability: request.capability,
        reason,
      });
      if (options.rethrow) throw options.rethrow;
      throw new ServiceUnavailableException(
        `Search capability "${request.capability}" is unavailable (${reason})`,
      );
    }
    this.events.emit('search.engine_fallback', {
      capability: request.capability,
      requestedEngine: 'opensearch',
      actualEngine: 'mongodb',
      fallbackUsed: true,
      fallbackReason: reason,
    });
    return this.serve('mongodb', request, {
      requestedEngine: 'opensearch',
      actualEngine: 'mongodb',
      fallbackUsed: true,
      fallbackReason: reason,
      degraded: true,
      ...(plan.degradedSemantics
        ? { degradedSemantics: plan.degradedSemantics }
        : {}),
    });
  }

  /**
   * Runs one engine with a cursor that engine can actually read, and tags the
   * cursor it produces.
   *
   * When the incoming cursor came from the other engine the module restarts at
   * its first page: the page the caller already saw is repeated. That is on
   * purpose — the alternative, ending pagination for the module, hides results
   * that exist, and a repeated row is visible to the user while a missing one is
   * not. `cursorReset` carries the fact upwards so it can be reported.
   */
  private async serve(
    engine: SearchEngine['name'],
    request: EngineSearchRequest,
    routing: Omit<
      RoutedSearchResponse,
      keyof EngineSearchResponse | 'cursorReset'
    > & { degraded: boolean },
  ): Promise<RoutedSearchResponse> {
    const incoming = decodeEngineCursor(request.cursor);
    const cursorReset = Boolean(request.cursor) && incoming?.engine !== engine;
    if (cursorReset) {
      this.logger.warn(
        `Search cursor was minted by ${
          incoming?.engine ?? 'an older build'
        } but ${engine} is serving ${
          request.module
        }; restarting that module at its first page`,
      );
      this.metrics.incrementCounter('crm_search_cursor_reset_total', {
        engine,
        module: request.module,
      });
    }
    const response = await (
      engine === 'opensearch' ? this.openSearch : this.mongo
    ).search({
      ...request,
      cursor: cursorReset ? undefined : incoming?.cursor,
    });
    return {
      ...response,
      nextCursor: response.nextCursor
        ? encodeEngineCursor(engine, response.nextCursor)
        : null,
      ...routing,
      cursorReset,
    };
  }

  private breakerFor(capability: SearchCapabilityName): BreakerState {
    let state = this.breakers.get(capability);
    if (!state) {
      state = { consecutiveFailures: 0, openUntil: 0 };
      this.breakers.set(capability, state);
    }
    return state;
  }

  private breakerOpen(capability: SearchCapabilityName): boolean {
    const state = this.breakerFor(capability);
    if (state.openUntil === 0) return false;
    if (Date.now() < state.openUntil) return true;
    // Cooldown elapsed: let the next request through as a probe. One more
    // failure re-opens it immediately.
    state.openUntil = 0;
    state.consecutiveFailures = BREAKER_THRESHOLD - 1;
    return false;
  }

  private recordSuccess(capability: SearchCapabilityName): void {
    const state = this.breakerFor(capability);
    if (state.consecutiveFailures > 0 || state.openUntil !== 0) {
      this.logger.log(
        `OpenSearch recovered for ${capability}; routing it back to OpenSearch`,
      );
    }
    state.consecutiveFailures = 0;
    state.openUntil = 0;
  }

  private recordFailure(
    capability: SearchCapabilityName,
    reason: string,
  ): void {
    const state = this.breakerFor(capability);
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures < BREAKER_THRESHOLD) return;
    state.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    this.logger.error(
      `OpenSearch failed ${state.consecutiveFailures} times in a row for ${capability} (${reason}); applying its unavailable policy for ${
        BREAKER_COOLDOWN_MS / 1000
      }s`,
    );
    this.metrics.incrementCounter('crm_search_breaker_opened_total', {
      capability,
      reason,
    });
  }
}
