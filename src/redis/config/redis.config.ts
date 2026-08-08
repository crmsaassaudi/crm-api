import { registerAs } from '@nestjs/config';
import { RedisConfig, RedisEndpoint } from './redis-config.type';
import { IsInt, IsOptional, IsString, Min, Max } from 'class-validator';
import validateConfig from '../../utils/validate-config';

class EnvironmentVariablesValidator {
  @IsString()
  @IsOptional()
  REDIS_HOST: string;

  @IsInt()
  @Min(0)
  @Max(65535)
  @IsOptional()
  REDIS_PORT: number;

  @IsString()
  @IsOptional()
  REDIS_PASSWORD: string;

  @IsInt()
  @IsOptional()
  REDIS_DB: number;

  @IsInt()
  @IsOptional()
  REDIS_TTL: number;

  @IsString()
  @IsOptional()
  REDIS_URL: string;

  @IsString()
  @IsOptional()
  REDIS_CACHE_URL: string;

  @IsInt()
  @IsOptional()
  REDIS_CACHE_DB: number;
}

export default registerAs<RedisConfig>('redis', () => {
  validateConfig(process.env, EnvironmentVariablesValidator);

  // The core endpoint: session, distributed locks, idempotency claims and the
  // Socket.IO pub/sub adapter. Deliberately does NOT consider REDIS_CACHE_URL —
  // it used to, which meant pointing cache at its own instance silently moved
  // every lock and idempotency key there too, onto a policy built to evict them.
  const core = parseRedisUrl(process.env.REDIS_URL);
  const host = core.host ?? process.env.REDIS_HOST ?? 'localhost';
  const port = core.port ?? parseInt(process.env.REDIS_PORT ?? '6379', 10);
  const password = core.password ?? process.env.REDIS_PASSWORD ?? undefined;
  const db = core.db ?? parseOptionalInt(process.env.REDIS_DB) ?? 0;
  const cacheDb = parseOptionalInt(process.env.REDIS_CACHE_DB) ?? 2;

  // The cache endpoint. Falls back to the core instance at `cacheDb`, so a
  // deployment that has not split its Redis yet behaves exactly as before.
  const cacheUrl = parseRedisUrl(process.env.REDIS_CACHE_URL);
  const cache: RedisEndpoint = {
    host: cacheUrl.host ?? host,
    port: cacheUrl.port ?? port,
    password: cacheUrl.password ?? password,
    // A dedicated cache instance carries its db in the URL path; give that
    // precedence over REDIS_CACHE_DB, which only describes the shared layout.
    db: cacheUrl.db ?? cacheDb,
  };

  return {
    url: process.env.REDIS_URL,
    host,
    port,
    password,
    db,
    cacheDb,
    cache,
    ttl: process.env.REDIS_TTL ? parseInt(process.env.REDIS_TTL, 10) : 86400, // 24 hours default
  };
});

function parseOptionalInt(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseRedisUrl(url?: string): Partial<RedisConfig> {
  if (!url) return {};
  try {
    const parsed = new URL(url);
    const db = parsed.pathname?.replace('/', '');
    return {
      host: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : undefined,
      password: parsed.password
        ? decodeURIComponent(parsed.password)
        : undefined,
      db: db ? parseOptionalInt(db) : undefined,
    };
  } catch {
    return {};
  }
}
