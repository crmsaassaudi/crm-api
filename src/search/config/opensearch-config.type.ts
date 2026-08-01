import {
  CapabilityOverride,
  SearchCapabilityName,
} from '../capabilities/search-capabilities';

export interface OpenSearchConfig {
  enabled: boolean;
  node: string;
  username?: string;
  password?: string;
  indexPrefix: string;
  /**
   * @deprecated Superseded by each capability's `onOwnerUnavailable`. One flag
   * for every capability is what let an OpenSearch outage aim every search at
   * the primary at once. Kept only so an existing environment that sets it to
   * `false` still fails closed; `true` no longer grants a blanket fallback.
   */
  fallbackToMongoDb: boolean;
  requestTimeoutMs: number;
  /** Per-capability operator overrides; may only narrow. */
  capabilityOverrides: Partial<
    Record<SearchCapabilityName, CapabilityOverride>
  >;
}
