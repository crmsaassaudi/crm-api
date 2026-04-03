import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import { IOREDIS_CLIENT } from './redis.tokens';

@Injectable()
export class RedisEvictionPolicyGuard implements OnModuleInit {
  private readonly logger = new Logger(RedisEvictionPolicyGuard.name);

  constructor(@Inject(IOREDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleInit(): Promise<void> {
    const requireNoEviction = this.isStrictModeEnabled();
    const autoFixEnabled = this.isAutoFixEnabled();

    let policy = await this.readMaxMemoryPolicy();
    if (!policy) {
      this.logger.warn(
        'Unable to determine Redis maxmemory-policy. ' +
          'Set REDIS_REQUIRE_NOEVICTION=true to enforce strict startup check.',
      );
      return;
    }

    if (policy !== 'noeviction') {
      if (autoFixEnabled) {
        const fixed = await this.trySetNoEviction();
        if (fixed) {
          policy = await this.readMaxMemoryPolicy();
        }
      }

      if (policy === 'noeviction') {
        this.logger.log('Redis maxmemory-policy auto-fixed to noeviction');
        return;
      }

      const message = this.buildPolicyMismatchMessage(policy ?? 'unknown');

      if (requireNoEviction) {
        this.logger.error(message);
        throw new Error(message);
      }

      this.logger.warn(
        `${message} Startup continues because strict mode is disabled.`,
      );
      return;
    }

    this.logger.log('Redis maxmemory-policy verified: noeviction');
  }

  private isStrictModeEnabled(): boolean {
    const explicit = process.env.REDIS_REQUIRE_NOEVICTION;
    if (explicit !== undefined) {
      return explicit.toLowerCase() === 'true';
    }

    // Default: strict only in production.
    return (process.env.NODE_ENV ?? '').toLowerCase() === 'production';
  }

  private isAutoFixEnabled(): boolean {
    const val = process.env.REDIS_AUTO_FIX_EVICTION_POLICY;
    if (val === undefined) {
      return true;
    }
    return val.toLowerCase() !== 'false';
  }

  private buildPolicyMismatchMessage(policy: string): string {
    return (
      `Redis maxmemory-policy is "${policy}". Expected "noeviction" ` +
      'to keep idempotency/lock/identity keys reliable. '
    );
  }

  private async trySetNoEviction(): Promise<boolean> {
    try {
      const result = (await this.redis.config(
        'SET',
        'maxmemory-policy',
        'noeviction',
      )) as string;
      return String(result).toUpperCase() === 'OK';
    } catch {
      return false;
    }
  }

  private async readMaxMemoryPolicy(): Promise<string | null> {
    try {
      const cfg = (await this.redis.config('GET', 'maxmemory-policy')) as
        | string[]
        | undefined;
      if (cfg && cfg.length >= 2 && cfg[1]) {
        return String(cfg[1]).toLowerCase();
      }
    } catch {
      // Managed Redis may block CONFIG GET; fallback to INFO.
    }

    try {
      const info = await this.redis.info('memory');
      const match = info.match(/^maxmemory_policy:([^\r\n]+)/m);
      return match?.[1]?.trim().toLowerCase() ?? null;
    } catch {
      return null;
    }
  }
}
