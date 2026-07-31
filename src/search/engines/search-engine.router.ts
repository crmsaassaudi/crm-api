import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
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
import { AuthorizationFilterException } from './opensearch-filter';
import { MetricsService } from '../../observability/metrics.service';

export interface RoutedSearchResponse extends EngineSearchResponse {
  requestedEngine: SearchEngine['name'];
  actualEngine: SearchEngine['name'];
  fallbackUsed: boolean;
  fallbackReason?: string;
}

@Injectable()
export class SearchEngineRouter {
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
      return {
        ...(await this.mongo.search(request)),
        requestedEngine: 'mongodb',
        actualEngine: 'mongodb',
        fallbackUsed: false,
      };
    }
    try {
      return {
        ...(await this.openSearch.search(request)),
        requestedEngine: 'opensearch',
        actualEngine: 'opensearch',
        fallbackUsed: false,
      };
    } catch (error) {
      const reason =
        error instanceof Error ? error.constructor.name : 'UnknownError';
      this.metrics.incrementCounter('crm_search_engine_errors_total', {
        engine: 'opensearch',
        reason,
      });
      if (
        error instanceof AuthorizationFilterException ||
        error instanceof BadRequestException ||
        error instanceof UnauthorizedException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      if (!config.fallbackToMongoDb) throw error;
      this.events.emit('search.engine_fallback', {
        requestedEngine: 'opensearch',
        actualEngine: 'mongodb',
        fallbackUsed: true,
        fallbackReason: reason,
      });
      return {
        ...(await this.mongo.search(request)),
        requestedEngine: 'opensearch',
        actualEngine: 'mongodb',
        fallbackUsed: true,
        fallbackReason: reason,
      };
    }
  }
}
