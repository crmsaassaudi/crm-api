import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequirePermission } from '../../common/permissions';
import { AgentReportService } from './agent-report.service';
import { GetAgentReportDto } from './dto/get-agent-report.dto';

@ApiTags('Agent Reports')
@ApiBearerAuth()
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Controller({ path: 'reports/agent', version: '1' })
export class AgentReportController {
  constructor(private readonly service: AgentReportService) {}

  /** Per-agent work-time + presence/routing/work breakdown + KPIs. */
  @Get('work-time')
  @RequirePermission('view', 'agent_reports')
  getWorkTime(@Query() query: GetAgentReportDto) {
    return this.service.getWorkTime(query);
  }

  /** Agent Performance Index ranking (with guardrails). */
  @Get('ranking')
  @RequirePermission('view', 'agent_reports')
  getRanking(@Query() query: GetAgentReportDto) {
    return this.service.getRanking(query);
  }
}
