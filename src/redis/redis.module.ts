/* eslint-disable no-restricted-syntax */
import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheModule } from '@nestjs/cache-manager';
import { RedisService } from './redis.service';
import { RedisLockService } from './redis-lock.service';
import { RedisEvictionPolicyGuard } from './redis-eviction-policy.guard';
import type { RedisOptions } from 'ioredis';
import * as redisStore from 'cache-manager-ioredis';
import Redis from 'ioredis';
import { IOREDIS_CLIENT } from './redis.tokens';

@Global()
@Module({
  imports: [
    CacheModule.registerAsync<RedisOptions>({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        store: redisStore as any,
        host: configService.get<string>('redis.host'),
        port: configService.get<number>('redis.port'),
        password: configService.get<string>('redis.password'),
        db: configService.get<number>('redis.cacheDb'), // Separate DB for cache (default 2)
        ttl: configService.get<number>('redis.ttl'),
      }),
    }),
  ],
  providers: [
    RedisService,
    RedisLockService,
    RedisEvictionPolicyGuard,
    {
      // Dedicated raw ioredis client — avoids cache-manager v7 store abstraction issues.
      provide: IOREDIS_CLIENT,
      useFactory: (configService: ConfigService) => {
        const client = new Redis({
          host: configService.get<string>('redis.host') ?? 'localhost',
          port: configService.get<number>('redis.port') ?? 6379,
          password: configService.get<string>('redis.password') || undefined,
          db: configService.get<number>('redis.db') ?? 0,
          lazyConnect: false,
          // CRIT-06: Required for BullMQ blocking commands
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          // MED-13: Resilient reconnection on Redis blip
          retryStrategy: (times: number) => Math.min(times * 200, 5000),
          reconnectOnError: (err: Error) =>
            err.message.includes('READONLY') ||
            err.message.includes('LOADING'),
        });
        // Persistent error listener — prevents uncaught 'error' event crash
        client.on('error', (err) => {
          // eslint-disable-next-line no-console
          console.error('[IOREDIS_CLIENT] Redis error:', err.message);
        });
        return client;
      },
      inject: [ConfigService],
    },
  ],
  exports: [RedisService, RedisLockService, CacheModule, IOREDIS_CLIENT],
})
export class RedisModule {}
