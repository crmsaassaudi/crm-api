import { Module, Global } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MongooseModule } from '@nestjs/mongoose';
import { ResilienceService } from './resilience.service';
import { ResilienceHttpService } from './resilience-http.service';
import { TestHttpController } from './test-http.controller';
import { ResilienceMetricsService } from './resilience-metrics.service';
import { ResilienceMetricsController } from './resilience-metrics.controller';
import { IntegrationLog, IntegrationLogSchema } from './integration-log.schema';
import { IntegrationLogService } from './integration-log.service';

import { IntegrationLogController } from './integration-log.controller';

@Global()
@Module({
  imports: [
    HttpModule,
    MongooseModule.forFeature([
      { name: IntegrationLog.name, schema: IntegrationLogSchema },
    ]),
  ],
  controllers: [
    TestHttpController,
    ResilienceMetricsController,
    IntegrationLogController,
  ],
  providers: [
    ResilienceService,
    ResilienceHttpService,
    ResilienceMetricsService,
    IntegrationLogService,
  ],
  exports: [
    HttpModule,
    ResilienceService,
    ResilienceHttpService,
    ResilienceMetricsService,
    IntegrationLogService,
  ],
})
export class HttpResilienceModule {}
