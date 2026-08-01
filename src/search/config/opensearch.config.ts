import { registerAs } from '@nestjs/config';
import {
  IsBooleanString,
  IsNumberString,
  IsOptional,
  IsString,
  IsUrl,
} from 'class-validator';
import validateConfig from '../../utils/validate-config';
import { OpenSearchConfig } from './opensearch-config.type';
import { parseCapabilityOverrides } from '../capabilities/search-capabilities';

class OpenSearchEnvironmentValidator {
  @IsBooleanString()
  @IsOptional()
  OPENSEARCH_ENABLED?: string;

  @IsUrl({ require_tld: false })
  @IsOptional()
  OPENSEARCH_NODE?: string;

  @IsString()
  @IsOptional()
  OPENSEARCH_USERNAME?: string;

  @IsString()
  @IsOptional()
  OPENSEARCH_PASSWORD?: string;

  @IsString()
  @IsOptional()
  OPENSEARCH_INDEX_PREFIX?: string;

  @IsBooleanString()
  @IsOptional()
  OPENSEARCH_FALLBACK_TO_MONGODB?: string;

  @IsNumberString()
  @IsOptional()
  OPENSEARCH_REQUEST_TIMEOUT_MS?: string;

  @IsString()
  @IsOptional()
  SEARCH_CAPABILITY_OVERRIDES?: string;
}

const flag = (value: string | undefined, defaultValue: boolean): boolean =>
  value === undefined ? defaultValue : value.toLowerCase() === 'true';

export default registerAs<OpenSearchConfig>('opensearch', () => {
  validateConfig(process.env, OpenSearchEnvironmentValidator);
  const enabled = flag(process.env.OPENSEARCH_ENABLED, false);
  const requestTimeoutMs = Number(
    process.env.OPENSEARCH_REQUEST_TIMEOUT_MS ?? 3_000,
  );
  if (requestTimeoutMs < 100 || requestTimeoutMs > 60_000) {
    throw new Error(
      'OPENSEARCH_REQUEST_TIMEOUT_MS must be between 100 and 60000',
    );
  }
  if (enabled && !process.env.OPENSEARCH_NODE) {
    throw new Error('OPENSEARCH_NODE is required when OpenSearch is enabled');
  }
  // Throws on an unknown capability, a typo, or an override that would widen
  // rather than narrow. Failing at boot is deliberate: an override that
  // silently does nothing is discovered during an incident.
  const capabilityOverrides = parseCapabilityOverrides(
    process.env.SEARCH_CAPABILITY_OVERRIDES,
  );
  return {
    enabled,
    node: process.env.OPENSEARCH_NODE ?? 'http://localhost:9200',
    username: process.env.OPENSEARCH_USERNAME || undefined,
    password: process.env.OPENSEARCH_PASSWORD || undefined,
    indexPrefix: process.env.OPENSEARCH_INDEX_PREFIX ?? 'crm',
    fallbackToMongoDb: flag(process.env.OPENSEARCH_FALLBACK_TO_MONGODB, true),
    requestTimeoutMs,
    capabilityOverrides,
  };
});
