import { Controller, Get } from '@nestjs/common';
import { ResilienceMetricsService } from './resilience-metrics.service';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Resilience')
@Controller('resilience')
export class ResilienceMetricsController {
  constructor(private readonly metricsService: ResilienceMetricsService) {}

  @Get('metrics')
  getMetrics() {
    return this.metricsService.getMetrics();
  }

  @Get('logs')
  getLogs() {
    return this.metricsService.getLogs();
  }
}
