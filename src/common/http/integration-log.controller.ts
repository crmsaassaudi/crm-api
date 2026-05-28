import { Controller, Get, Query } from '@nestjs/common';
import { IntegrationLogService } from './integration-log.service';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/permissions';

@ApiTags('Integration Monitoring')
@Controller('admin/integrations')
export class IntegrationLogController {
  constructor(private readonly integrationLogService: IntegrationLogService) {}

  @Get('metrics')
  @RequirePermission('view', 'integration_monitoring')
  async getMetrics() {
    return this.integrationLogService.getAggregatedMetrics();
  }

  @Get('logs')
  @RequirePermission('view', 'integration_monitoring')
  async getLogs(@Query('limit') limit: number = 100) {
    return this.integrationLogService.getRecentLogs(limit);
  }
}
