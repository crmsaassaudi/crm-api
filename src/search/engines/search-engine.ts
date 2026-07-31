import { SearchModule } from '../dto/global-search-query.dto';
import { GlobalSearchResult } from '../global-search.types';

export const MONGO_SEARCH_ENGINE = Symbol('MONGO_SEARCH_ENGINE');
export const OPENSEARCH_SEARCH_ENGINE = Symbol('OPENSEARCH_SEARCH_ENGINE');

export interface SearchScope {
  tenantId: string;
  userId: string;
  visibleOwnerIds: string[] | null;
  visibleOrgUnitIds: string[] | null;
  includeUnowned: boolean;
  abacFilter?: Record<string, unknown> | null;
}

export interface EngineSearchRequest {
  module: SearchModule;
  query: string;
  limit: number;
  cursor?: string;
  scope: SearchScope;
}

export interface EngineSearchResponse {
  data: GlobalSearchResult[];
  nextCursor: string | null;
}

export interface SearchEngine {
  readonly name: 'mongodb' | 'opensearch';
  search(request: EngineSearchRequest): Promise<EngineSearchResponse>;
}
