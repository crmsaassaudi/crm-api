import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequirePermission } from '../../common/permissions';
import { ContactReportService } from './contact-report.service';
import { GetContactReportDto } from './dto/get-contact-report.dto';
import { ContactReportRateLimitGuard } from './contact-report-rate-limit.guard';

@ApiTags('Contact Reports')
@ApiBearerAuth()
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@UseGuards(ContactReportRateLimitGuard)
@Controller({
  path: 'reports/contact',
  version: '1',
})
export class ContactReportController {
  constructor(private readonly service: ContactReportService) {}

  @Get('growth-trend')
  @RequirePermission('view', 'contact_reports')
  getGrowthTrend(@Query() query: GetContactReportDto) {
    return this.service.getGrowthTrend(query);
  }

  @Get('source-attribution')
  @RequirePermission('view', 'contact_reports')
  getSourceAttribution(@Query() query: GetContactReportDto) {
    return this.service.getSourceAttribution(query);
  }

  @Get('assignment-distribution')
  @RequirePermission('view', 'contact_reports')
  getAssignmentDistribution(@Query() query: GetContactReportDto) {
    return this.service.getAssignmentDistribution(query);
  }

  @Get('stale-contacts')
  @RequirePermission('view', 'contact_reports')
  getStaleContacts(@Query() query: GetContactReportDto) {
    return this.service.getStaleContacts(query);
  }

  @Get('score-distribution')
  @RequirePermission('view', 'contact_reports')
  getScoreDistribution(@Query() query: GetContactReportDto) {
    return this.service.getScoreDistribution(query);
  }

  @Get('opt-out-rate')
  @RequirePermission('view', 'contact_reports')
  getOptOutRate(@Query() query: GetContactReportDto) {
    return this.service.getOptOutRate(query);
  }

  @Get('omni-activation')
  @RequirePermission('view', 'contact_reports')
  getOmniActivation(@Query() query: GetContactReportDto) {
    return this.service.getOmniActivation(query);
  }

  @Get('shadow-conversion')
  @RequirePermission('view', 'contact_reports')
  getShadowConversion(@Query() query: GetContactReportDto) {
    return this.service.getShadowConversion(query);
  }

  @Get('funnel-velocity')
  @RequirePermission('view', 'contact_reports')
  getFunnelVelocity(@Query() query: GetContactReportDto) {
    return this.service.getFunnelVelocity(query);
  }

  @Get('funnel-leakage')
  @RequirePermission('view', 'contact_reports')
  getFunnelLeakage(@Query() query: GetContactReportDto) {
    return this.service.getFunnelLeakage(query);
  }
}
