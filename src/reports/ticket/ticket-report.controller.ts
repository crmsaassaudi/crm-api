import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequirePermission } from '../../common/permissions';
import { TicketReportService } from './ticket-report.service';
import { GetTicketReportDto } from './dto/get-ticket-report.dto';

@ApiTags('Ticket Reports')
@ApiBearerAuth()
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Controller({ path: 'reports/ticket', version: '1' })
export class TicketReportController {
  constructor(private readonly service: TicketReportService) {}

  @Get('volume')
  @RequirePermission('view', 'ticket_reports')
  getVolume(@Query() query: GetTicketReportDto) {
    return this.service.getVolume(query);
  }

  @Get('sla-compliance')
  @RequirePermission('view', 'ticket_reports')
  getSlaCompliance(@Query() query: GetTicketReportDto) {
    return this.service.getSlaCompliance(query);
  }

  @Get('resolution-time')
  @RequirePermission('view', 'ticket_reports')
  getResolutionTime(@Query() query: GetTicketReportDto) {
    return this.service.getResolutionTime(query);
  }

  @Get('agent-workload')
  @RequirePermission('view', 'ticket_reports')
  getAgentWorkload(@Query() query: GetTicketReportDto) {
    return this.service.getAgentWorkload(query);
  }

  @Get('breakdown')
  @RequirePermission('view', 'ticket_reports')
  getBreakdown(@Query() query: GetTicketReportDto) {
    return this.service.getBreakdown(query);
  }

  @Get('csat')
  @RequirePermission('view', 'ticket_reports')
  getCsat(@Query() query: GetTicketReportDto) {
    return this.service.getCsat(query);
  }
}
