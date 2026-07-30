import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import { IOREDIS_CLIENT } from './redis.tokens';

@Injectable()
export class RedisEvictionPolicyGuard implements OnModuleInit {
  private readonly logger = new Logger(RedisEvictionPolicyGuard.name);

  constructor(@Inject(IOREDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Budget for the startup policy probe.
   *
   * The shared ioredis client runs with `maxRetriesPerRequest: null` (BullMQ needs
   * it for blocking commands), which means a command issued while Redis is not
   * answering is retried forever and **never rejects** — so the try/catch below
   * can never fire. A Redis that accepts connections but does not reply therefore
   * hung the whole API at boot: no error, no listener, container reporting "Up".
   *
   * This is an advisory check. It must never be able to prevent startup.
   */
  private static readonly PROBE_TIMEOUT_MS = 5_000;

  async onModuleInit(): Promise<void> {
    const requireNoEviction = this.isStrictModeEnabled();
    const autoFixEnabled = this.isAutoFixEnabled();

    let policy = await this.withTimeout(
      this.readMaxMemoryPolicy(),
      'read maxmemory-policy',
    );
    if (!policy) {
      this.logger.warn(
        'Unable to determine Redis maxmemory-policy. ' +
          'Set REDIS_REQUIRE_NOEVICTION=true to enforce strict startup check.',
      );
      return;
    }

    if (policy !== 'noeviction') {
      if (autoFixEnabled) {
        const fixed = await this.withTimeout(
          this.trySetNoEviction(),
          'set maxmemory-policy',
        );
        if (fixed) {
          policy = await this.withTimeout(
            this.readMaxMemoryPolicy(),
            'read maxmemory-policy',
          );
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
    if (val !== undefined) {
      return val.toLowerCase() === 'true';
    }
    // Auto-fix is opt-in in production to avoid silent Redis config changes.
    return (process.env.NODE_ENV ?? '').toLowerCase() !== 'production';
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

  /**
   * Resolves to `null` if the Redis command does not answer in time, so a stuck
   * Redis degrades this check instead of blocking the process from starting.
   */
  private async withTimeout<T>(
    operation: Promise<T>,
    label: string,
  ): Promise<T | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            this.logger.warn(
              `Redis did not answer "${label}" within ` +
                `${RedisEvictionPolicyGuard.PROBE_TIMEOUT_MS}ms — skipping the ` +
                'eviction-policy check. Redis may be blocked or unreachable.',
            );
            resolve(null);
          }, RedisEvictionPolicyGuard.PROBE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
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
      const match = /^maxmemory_policy:([^\r\n]+)/m.exec(info);
      return match?.[1]?.trim().toLowerCase() ?? null;
    } catch {
      return null;
    }
  }
}
