/* eslint-disable no-restricted-syntax */
import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheModule } from '@nestjs/cache-manager';
import { RedisService } from './redis.service';
import { RedisLockService } from './redis-lock.service';
import { IdempotencyService } from './idempotency.service';
import { RedisEvictionPolicyGuard } from './redis-eviction-policy.guard';
import type { RedisOptions } from 'ioredis';
// @ts-expect-error -- cache-manager-ioredis does not ship type declarations
import * as redisStore from 'cache-manager-ioredis';
import Redis from 'ioredis';
import { IOREDIS_CLIENT } from './redis.tokens';
import type { RedisEndpoint } from './config/redis-config.type';

@Global()
@Module({
  imports: [
    CacheModule.registerAsync<RedisOptions>({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        // Its own endpoint, not `redis.host` + a db index. Cache is the only
        // thing here that may be evicted, and `maxmemory-policy` is per
        // instance — so in the split layout this resolves to a different
        // instance entirely (allkeys-lru), while the raw client below stays on
        // the noeviction one. Falls back to the core host when unsplit.
        const cache = configService.getOrThrow<RedisEndpoint>('redis.cache');
        return {
          store: redisStore as any,
          host: cache.host,
          port: cache.port,
          password: cache.password,
          db: cache.db,
          ttl: configService.get<number>('redis.ttl'),
        };
      },
    }),
  ],
  providers: [
    RedisService,
    RedisLockService,
    IdempotencyService,
    RedisEvictionPolicyGuard,
    {
      // Dedicated raw ioredis client — avoids cache-manager v7 store abstraction issues.
      provide: IOREDIS_CLIENT,
      useFactory: (configService: ConfigService) => {
        const client = new Redis({
          host: configService.get<string>('redis.host') ?? 'localhost',
          port: configService.get<number>('redis.port') ?? 6379,
          password: configService.get<string>('redis.password') ?? undefined,
          db: configService.get<number>('redis.db') ?? 0,
          lazyConnect: false,
          // Required for BullMQ blocking commands
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          // Resilient reconnection on Redis blip
          retryStrategy: (times: number) => Math.min(times * 200, 5000),
          reconnectOnError: (err: Error) =>
            err.message.includes('READONLY') || err.message.includes('LOADING'),
        });
        // Persistent error listener — prevents uncaught 'error' event crash
        client.on('error', (err) => {
          console.error('[IOREDIS_CLIENT] Redis error:', err.message);
        });
        return client;
      },
      inject: [ConfigService],
    },
  ],
  exports: [
    RedisService,
    RedisLockService,
    IdempotencyService,
    CacheModule,
    IOREDIS_CLIENT,
  ],
})
export class RedisModule {}
