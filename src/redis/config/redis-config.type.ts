export type RedisConfig = {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  /** Separate DB index for cache-manager (avoids key collisions with locks/queues). */
  cacheDb?: number;
  ttl?: number;
};
