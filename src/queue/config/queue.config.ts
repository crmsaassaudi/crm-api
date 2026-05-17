import { registerAs } from '@nestjs/config';
import { QueueConfig } from './queue-config.type';
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

  @IsString()
  @IsOptional()
  REDIS_URL: string;

  @IsString()
  @IsOptional()
  REDIS_QUEUE_URL: string;

  @IsInt()
  @IsOptional()
  REDIS_QUEUE_DB: number;
}

export default registerAs<QueueConfig>('queue', () => {
  validateConfig(process.env, EnvironmentVariablesValidator);
  const url = process.env.REDIS_QUEUE_URL || process.env.REDIS_URL;
  const parsed = parseRedisUrl(url);

  return {
    url,
    host: parsed.host || process.env.REDIS_HOST || 'localhost',
    port: parsed.port ?? parseInt(process.env.REDIS_PORT || '6379', 10),
    password: parsed.password || process.env.REDIS_PASSWORD || undefined,
    db:
      parseOptionalInt(process.env.REDIS_QUEUE_DB) ??
      parsed.db ??
      parseOptionalInt(process.env.REDIS_DB) ??
      1,
  };
});

function parseOptionalInt(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseRedisUrl(url?: string): Partial<QueueConfig> {
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
