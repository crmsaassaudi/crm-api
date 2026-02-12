import { Module, Global } from '@nestjs/common';
import { CacheInvalidationService } from './cache-invalidation.service';
import { CacheInvalidationListener } from './invalidation/cache-invalidation.listener';
import { RedisModule } from '../../redis/redis.module';

@Global()
@Module({
  imports: [RedisModule],
  providers: [CacheInvalidationService, CacheInvalidationListener],
  exports: [CacheInvalidationService],
})
export class CommonCacheModule {}
