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

export interface RoutedSearchResponse extends EngineSearchResponse {
  requestedEngine: SearchEngine['name'];
  actualEngine: SearchEngine['name'];
  fallbackUsed: boolean;
  fallbackReason?: string;
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

@Injectable()
export class SearchEngineRouter {
  private readonly logger = new Logger(SearchEngineRouter.name);
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(
    private readonly configService: ConfigService<AllConfigType>,
    @Inject(MONGO_SEARCH_ENGINE) private readonly mongo: SearchEngine,
    @Inject(OPENSEARCH_SEARCH_ENGINE) private readonly openSearch: SearchEngine,
    private readonly events: EventEmitter2,
    private readonly metrics: MetricsService,
  ) {}

  async search(request: EngineSearchRequest): Promise<RoutedSearchResponse> {
    const config = this.configService.getOrThrow('opensearch', { infer: true });
    if (!config.enabled) {
      return this.serve('mongodb', request, {
        requestedEngine: 'mongodb',
        actualEngine: 'mongodb',
        fallbackUsed: false,
      });
    }

    // While OpenSearch is known to be down, every module of every keystroke
    // used to burn its full timeout before falling back — five extra text
    // queries per request aimed at the primary, at exactly the wrong moment.
    if (this.breakerOpen()) {
      return this.fallback(request, 'circuit_open', config.fallbackToMongoDb);
    }

    try {
      const response = await this.serve('opensearch', request, {
        requestedEngine: 'opensearch',
        actualEngine: 'opensearch',
        fallbackUsed: false,
      });
      this.recordSuccess();
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
        // Fail closed when there is nowhere faithful to send it.
        if (!config.fallbackToMongoDb) throw error;
        return this.fallback(request, 'filter_unsupported', true);
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
      this.recordFailure(reason);
      if (!config.fallbackToMongoDb) throw error;
      return this.fallback(request, reason, true);
    }
  }

  async closeOpenSearchSnapshot(snapshotId: string): Promise<void> {
    await this.openSearch.closeSnapshot?.(snapshotId);
  }

  private async fallback(
    request: EngineSearchRequest,
    reason: string,
    allowed: boolean,
  ): Promise<RoutedSearchResponse> {
    if (!allowed) {
      throw new ServiceUnavailableException(
        `Search engine unavailable (${reason})`,
      );
    }
    this.events.emit('search.engine_fallback', {
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
    >,
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

  private breakerOpen(): boolean {
    if (this.openUntil === 0) return false;
    if (Date.now() < this.openUntil) return true;
    // Cooldown elapsed: let the next request through as a probe. One more
    // failure re-opens it immediately.
    this.openUntil = 0;
    this.consecutiveFailures = BREAKER_THRESHOLD - 1;
    return false;
  }

  private recordSuccess(): void {
    if (this.consecutiveFailures > 0 || this.openUntil !== 0) {
      this.logger.log('OpenSearch recovered; routing search back to it');
    }
    this.consecutiveFailures = 0;
    this.openUntil = 0;
  }

  private recordFailure(reason: string): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < BREAKER_THRESHOLD) return;
    this.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    this.logger.error(
      `OpenSearch failed ${this.consecutiveFailures} times in a row (${reason}); serving search from MongoDB for ${
        BREAKER_COOLDOWN_MS / 1000
      }s`,
    );
    this.metrics.incrementCounter('crm_search_breaker_opened_total', {
      reason,
    });
  }
}
