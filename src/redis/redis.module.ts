/* eslint-disable no-restricted-syntax */
import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheModule } from '@nestjs/cache-manager';
import { RedisService } from './redis.service';
import { RedisLockService } from './redis-lock.service';
import type { RedisOptions } from 'ioredis';
import * as redisStore from 'cache-manager-ioredis';

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
        db: configService.get<number>('redis.db'),
        ttl: configService.get<number>('redis.ttl'),
      }),
    }),
  ],
  providers: [RedisService, RedisLockService],
  exports: [RedisService, RedisLockService, CacheModule],
})
export class RedisModule { }
