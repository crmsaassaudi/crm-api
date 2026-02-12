import { Controller, Get, Query } from '@nestjs/common';
import { IntegrationLogService } from './integration-log.service';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Integration Monitoring')
@Controller('admin/integrations')
export class IntegrationLogController {
  constructor(private readonly integrationLogService: IntegrationLogService) {}

  @Get('metrics')
  async getMetrics() {
    return this.integrationLogService.getAggregatedMetrics();
  }

  @Get('logs')
  async getLogs(@Query('limit') limit: number = 100) {
    return this.integrationLogService.getRecentLogs(limit);
  }
}
