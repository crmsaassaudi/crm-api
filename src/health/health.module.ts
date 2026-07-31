import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { RedisModule } from '../redis/redis.module';
import { SearchModule } from '../search/search.module';
import { ObservabilityModule } from '../observability/observability.module';

@Module({
  imports: [RedisModule, SearchModule, ObservabilityModule],
  controllers: [HealthController],
})
export class HealthModule {}
