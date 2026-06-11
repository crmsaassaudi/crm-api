import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequirePermission } from '../../common/permissions';
import { OmniReportService } from './omni-report.service';
import { GetOmniReportDto } from './dto/get-omni-report.dto';

@ApiTags('Omni-Channel Reports')
@ApiBearerAuth()
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Controller({
  path: 'reports/omni',
  version: '1',
})
export class OmniReportController {
  constructor(private readonly service: OmniReportService) {}

  // ── Phase 1 ─────────────────────────────────────────────────────

  @Get('conversation-volume')
  @RequirePermission('view', 'omni_reports')
  getConversationVolume(@Query() query: GetOmniReportDto) {
    return this.service.getConversationVolume(query);
  }

  @Get('channel-distribution')
  @RequirePermission('view', 'omni_reports')
  getChannelDistribution(@Query() query: GetOmniReportDto) {
    return this.service.getChannelDistribution(query);
  }

  @Get('agent-performance')
  @RequirePermission('view', 'omni_reports')
  getAgentPerformance(@Query() query: GetOmniReportDto) {
    return this.service.getAgentPerformance(query);
  }

  @Get('response-time')
  @RequirePermission('view', 'omni_reports')
  getResponseTime(@Query() query: GetOmniReportDto) {
    return this.service.getResponseTime(query);
  }

  @Get('resolution-summary')
  @RequirePermission('view', 'omni_reports')
  getResolutionSummary(@Query() query: GetOmniReportDto) {
    return this.service.getResolutionSummary(query);
  }

  @Get('message-volume')
  @RequirePermission('view', 'omni_reports')
  getMessageVolume(@Query() query: GetOmniReportDto) {
    return this.service.getMessageVolume(query);
  }

  // ── Phase 2 ─────────────────────────────────────────────────────

  @Get('bot-performance')
  @RequirePermission('view', 'omni_reports')
  getBotPerformance(@Query() query: GetOmniReportDto) {
    return this.service.getBotPerformance(query);
  }

  @Get('peak-hours')
  @RequirePermission('view', 'omni_reports')
  getPeakHours(@Query() query: GetOmniReportDto) {
    return this.service.getPeakHours(query);
  }

  @Get('tag-analytics')
  @RequirePermission('view', 'omni_reports')
  getTagAnalytics(@Query() query: GetOmniReportDto) {
    return this.service.getTagAnalytics(query);
  }

  @Get('reopen-rate')
  @RequirePermission('view', 'omni_reports')
  getReopenRate(@Query() query: GetOmniReportDto) {
    return this.service.getReopenRate(query);
  }
}
