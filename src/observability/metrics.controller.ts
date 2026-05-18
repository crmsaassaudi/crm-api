import { Controller, Get, Header } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Unprotected } from 'nest-keycloak-connect';
import { MetricsService } from './metrics.service';

@Controller({ path: 'metrics', version: '1' })
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  @Unprotected()
  @SkipThrottle()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  getMetrics(): string {
    return this.metricsService.toPrometheus();
  }
}
