import { SearchModule } from '../dto/global-search-query.dto';
import { GlobalSearchResult } from '../global-search.types';
import { SearchCapabilityName } from '../capabilities/search-capabilities';

export const MONGO_SEARCH_ENGINE = Symbol('MONGO_SEARCH_ENGINE');
export const OPENSEARCH_SEARCH_ENGINE = Symbol('OPENSEARCH_SEARCH_ENGINE');

export interface SearchScope {
  tenantId: string;
  userId: string;
  visibleOwnerIds: string[] | null;
  visibleOrgUnitIds: string[] | null;
  includeUnowned: boolean;
  abacFilter?: Record<string, unknown> | null;
  /**
   * The legacy `data_access_policy.restrict_own_contacts` flag. The contact
   * repository applies it on the MongoDB path, so without it here the two
   * engines disagree about what a scoped user may see — and OpenSearch is the
   * wider of the two.
   */
  restrictToOwnerUserId?: string | null;
  /**
   * Whether the caller may match the query against values that field masking
   * hides from them — phone numbers and e-mail addresses.
   *
   * Both engines have to honour it or the control has a hole on one of them:
   * MongoDB keeps those tokens in `searchKeysPii`, OpenSearch in
   * `phoneSuffixes`. Absent means no.
   */
  canSearchSensitive?: boolean;
}

export interface EngineSearchRequest {
  /**
   * Which declared capability this request belongs to. The router uses it to
   * look up the owning engine and the policy for when that engine is down —
   * so the engine follows from the nature of the question, not from whether a
   * cluster happens to be reachable.
   */
  capability: SearchCapabilityName;
  module: SearchModule;
  query: string;
  limit: number;
  cursor?: string;
  /** Shared OpenSearch PIT for every module in one global-search snapshot. */
  snapshotId?: string;
  scope: SearchScope;
}

export interface EngineSearchResponse {
  data: GlobalSearchResult[];
  nextCursor: string | null;
  /** Latest PIT id returned by the engine; OpenSearch may rotate it per page. */
  snapshotId?: string;
}

export interface SearchEngine {
  readonly name: 'mongodb' | 'opensearch';
  search(request: EngineSearchRequest): Promise<EngineSearchResponse>;
  closeSnapshot?(snapshotId: string): Promise<void>;
}
