import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CsatService, CsatSubmitDto } from './csat.service';
import { RequirePermission } from '../../common/permissions';
import { Public } from '../../auth/decorators/public.decorator';
import { ClsService } from 'nestjs-cls';

@ApiTags('CSAT')
@Controller({ path: 'csat', version: '1' })
export class CsatController {
  constructor(
    private readonly csatService: CsatService,
    private readonly cls: ClsService,
  ) {}

  /**
   * Public endpoint — no auth required.
   * Customer submits their CSAT rating via survey link:
   *   GET  /survey?token=xxx            → renders survey page (handled by frontend)
   *   POST /v1/csat/submit/:token       → submits the rating
   *
   * Task B: Throttle to 5 requests/min to prevent spam scoring.
   * Token is a 32-char hex UUID — not brute-forceable, but rate limiting
   * prevents flood submission from bots or duplicate form submits.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('submit/:token')
  @ApiOperation({ summary: 'Submit CSAT rating (public, no auth)' })
  submitCsat(@Param('token') token: string, @Body() dto: CsatSubmitDto) {
    return this.csatService.submitByToken(token, dto);
  }

  /**
   * Internal endpoint — generate a survey token for a resolved conversation.
   * Called by the agent when they resolve a conversation.
   */
  @ApiBearerAuth()
  @RequirePermission('edit', 'tickets') // same tier as closing tickets
  @Post('generate-token/:conversationId')
  @ApiOperation({ summary: 'Generate CSAT survey token for a conversation' })
  generateToken(@Param('conversationId') conversationId: string) {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    return this.csatService.generateToken(conversationId, tenantId);
  }

  /**
   * CSAT report — aggregate metrics for reporting dashboard.
   */
  @ApiBearerAuth()
  @RequirePermission('view', 'reports')
  @Get('report')
  @ApiOperation({ summary: 'Get CSAT aggregate report' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'agentId', required: false })
  @ApiQuery({ name: 'channelType', required: false })
  getReport(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('agentId') agentId?: string,
    @Query('channelType') channelType?: string,
  ) {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    return this.csatService.getReport(tenantId, {
      from,
      to,
      agentId,
      channelType,
    });
  }
}
