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
  ) { }

  async get<T>(key: string): Promise<T | undefined> {
    return this.cacheManager.get<T>(key);
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    await this.cacheManager.set(key, value, ttl);
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
