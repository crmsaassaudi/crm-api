/** A resolved connection target. Every field is decided at config time. */
export type RedisEndpoint = {
  host: string;
  port: number;
  password?: string;
  db: number;
};

export type RedisConfig = {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  /**
   * DB index for cache-manager when it shares an instance with the core keys.
   *
   * Only meaningful in the single-instance layout. Once `REDIS_CACHE_URL` points
   * cache at its own instance, that URL's own db wins and this is unused.
   */
  cacheDb?: number;
  ttl?: number;
  /**
   * Where cache-manager connects.
   *
   * Resolved separately from the fields above because the two have opposite
   * eviction requirements: cache is recomputable and should drop keys under
   * pressure, while session/lock/idempotency must not. `maxmemory-policy` is a
   * per-instance setting, so satisfying both means two instances — and
   * therefore two endpoints, not two db indices on one.
   *
   * Defaults to the core endpoint at {@link cacheDb}, which keeps the
   * single-instance layout working unchanged.
   */
  cache: RedisEndpoint;
};
