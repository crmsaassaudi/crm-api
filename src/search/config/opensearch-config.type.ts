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
  requestTimeoutMs: number;
  /** Per-capability operator overrides; may only narrow. */
  capabilityOverrides: Partial<
    Record<SearchCapabilityName, CapabilityOverride>
  >;
}
