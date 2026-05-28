import { Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { IOREDIS_CLIENT } from './redis.tokens';
import type Redis from 'ioredis';

@Injectable()
export class RedisService {
  constructor(
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    @Inject(IOREDIS_CLIENT) private readonly ioredis: Redis,
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    return this.cacheManager.get<T>(key);
  }

  /**
   * Store a value in cache.
   * @param key   Cache key
   * @param value Value to cache (will be serialized by cache-manager)
   * @param ttlSeconds  Time-to-live in **seconds**. Internally converted to
   *                    milliseconds for cache-manager v5+/v7 compatibility.
   */
  async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
    const ttlMs = ttlSeconds != null ? ttlSeconds * 1000 : undefined;
    await this.cacheManager.set(key, value, ttlMs);
  }

  async del(key: string): Promise<void> {
    await this.cacheManager.del(key);
  }

  /**
   * Returns the raw ioredis client for operations that require
   * atomic commands (SET NX PX, GETDEL, etc.) not supported by cache-manager.
   */
  getClient(): Redis {
    return this.ioredis;
  }
}
