import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ulid } from 'ulid';
import { RedisService } from './redis.service';

export class LockLostError extends Error {
  constructor(key: string) {
    super(`Lost Redis lock ownership during execution of key: ${key}`);
    this.name = 'LockLostError';
  }
}

export interface AcquireOptions {
  /** Time-to-live in ms for the lock. Default 5000. */
  ttl?: number;
  /** Retry delay in ms between SET NX attempts. Default 100. */
  retryDelay?: number;
  /**
   * Max retries when contended. If unspecified we scale based on TTL so the
   * caller never waits less than the lock holder might hold for.
   */
  maxRetries?: number;
}

export type LockCallback<T> = (signal: AbortSignal) => Promise<T>;

@Injectable()
export class RedisLockService {
  private readonly logger = new Logger(RedisLockService.name);
  private readonly releaseScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    end
    return 0
  `;
  private readonly extendScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("pexpire", KEYS[1], ARGV[2])
    end
    return 0
  `;

  constructor(private readonly redisService: RedisService) {}

  /**
   * Acquire a Redis lock and run callback. Heartbeat extends the TTL while the
   * callback runs. If the heartbeat ever fails to extend (network / lock
   * stolen by another process / expired), an AbortSignal is fired so the
   * callback can short-circuit, and a LockLostError is thrown after callback
   * resolves so the result is discarded.
   *
   * Backwards compatible: legacy callers can pass positional args
   * `(key, ttl, callback, retryDelay, maxRetries)`. New callers should pass an
   * options object and a callback taking AbortSignal.
   */
  async acquire<T>(
    key: string,
    ttlOrOptions: number | AcquireOptions,
    callback: (() => Promise<T>) | LockCallback<T>,
    retryDelay = 100,
    maxRetries?: number,
  ): Promise<T> {
    const opts: AcquireOptions =
      typeof ttlOrOptions === 'number'
        ? { ttl: ttlOrOptions, retryDelay, maxRetries }
        : ttlOrOptions;

    const ttl = opts.ttl ?? 5_000;
    const delay = opts.retryDelay ?? 100;
    // Default: keep retrying for ~1.5× ttl so we never give up sooner than
    // the current lock holder could finish. Old default of 50 (≈5s) was too
    // tight for long-running jobs with ttl=30s.
    const effectiveMaxRetries =
      opts.maxRetries ?? Math.max(50, Math.ceil((ttl * 1.5) / delay));

    const client = this.redisService.getClient();
    const lockValue = ulid();
    let retries = 0;

    while (retries < effectiveMaxRetries) {
      const result = await client.set(key, lockValue, 'PX', ttl, 'NX');

      if (result === 'OK') {
        const abort = new AbortController();
        let lockLost = false;
        let active = true;
        const heartbeatMs = Math.max(100, Math.floor(ttl / 3));

        const heartbeat = setInterval(() => {
          // Once we're tearing down we ignore late heartbeat results — the
          // finally block will release the lock if we still own it.
          if (!active) return;
          void client
            .eval(this.extendScript, 1, key, lockValue, ttl.toString())
            .then((extended) => {
              if (!active) return;
              if (extended !== 1) {
                lockLost = true;
                this.logger.error(`Lost Redis lock ownership for key ${key}`);
                abort.abort();
              }
            })
            .catch((err) => {
              if (!active) return;
              lockLost = true;
              this.logger.error(
                `Failed to extend Redis lock ${key}: ${err.message}`,
              );
              abort.abort();
            });
        }, heartbeatMs);

        try {
          const value = await (callback as LockCallback<T>)(abort.signal);
          if (lockLost) {
            throw new LockLostError(key);
          }
          return value;
        } finally {
          active = false;
          clearInterval(heartbeat);
          try {
            await client.eval(this.releaseScript, 1, key, lockValue);
          } catch (err: any) {
            this.logger.warn(
              `Failed to release Redis lock ${key}: ${err.message}`,
            );
          }
        }
      }

      retries++;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    throw new InternalServerErrorException(
      `Could not acquire lock for key ${key} after ${effectiveMaxRetries} retries`,
    );
  }
}
