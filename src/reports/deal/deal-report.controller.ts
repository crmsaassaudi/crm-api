import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequirePermission } from '../../common/permissions';
import { DealReportService } from './deal-report.service';
import { GetDealReportDto } from './dto/get-deal-report.dto';

@ApiTags('Deal Reports')
@ApiBearerAuth()
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Controller({ path: 'reports/deal', version: '1' })
export class DealReportController {
  constructor(private readonly service: DealReportService) {}

  @Get('pipeline-summary')
  @RequirePermission('view', 'deal_reports')
  getPipelineSummary(@Query() query: GetDealReportDto) {
    return this.service.getPipelineSummary(query);
  }

  @Get('revenue-trend')
  @RequirePermission('view', 'deal_reports')
  getRevenueTrend(@Query() query: GetDealReportDto) {
    return this.service.getRevenueTrend(query);
  }

  @Get('win-loss-rate')
  @RequirePermission('view', 'deal_reports')
  getWinLossRate(@Query() query: GetDealReportDto) {
    return this.service.getWinLossRate(query);
  }

  @Get('aging')
  @RequirePermission('view', 'deal_reports')
  getDealAging(@Query() query: GetDealReportDto) {
    return this.service.getDealAging(query);
  }

  @Get('owner-performance')
  @RequirePermission('view', 'deal_reports')
  getOwnerPerformance(@Query() query: GetDealReportDto) {
    return this.service.getOwnerPerformance(query);
  }

  @Get('velocity')
  @RequirePermission('view', 'deal_reports')
  getDealVelocity(@Query() query: GetDealReportDto) {
    return this.service.getDealVelocity(query);
  }
}
