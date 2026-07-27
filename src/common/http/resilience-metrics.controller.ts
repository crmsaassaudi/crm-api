import { Controller, Get, UseGuards } from '@nestjs/common';
import { ResilienceMetricsService } from './resilience-metrics.service';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../roles/roles.decorator';
import { PlatformRoleEnum } from '../../roles/platform-role.enum';
import { RolesGuard } from '../../roles/roles.guard';

// Process-wide, cross-tenant circuit-breaker metrics and recent error logs —
// not scoped by tenant, so any tenant member (not just admins) could see
// other tenants' error traffic if this were left open at RBAC-only auth.
// Platform SUPER_ADMIN only, same as other ops/debug surfaces.
@ApiTags('Resilience')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles(PlatformRoleEnum.SUPER_ADMIN)
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
