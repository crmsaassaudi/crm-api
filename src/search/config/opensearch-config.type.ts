export interface OpenSearchConfig {
  enabled: boolean;
  node: string;
  username?: string;
  password?: string;
  indexPrefix: string;
  fallbackToMongoDb: boolean;
  requestTimeoutMs: number;
}
