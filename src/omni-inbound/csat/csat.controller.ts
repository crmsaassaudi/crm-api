import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CsatService, CsatSubmitDto } from './csat.service';
import { RequirePermission } from '../../common/permissions';
import { UseAcl } from '../../common/permissions/use-acl.decorator';
import { LoadResource } from '../../common/permissions/load-resource.decorator';
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
   * Internal endpoint — mint a survey token for a conversation.
   *
   * Gated on `omni_channel:edit` and the conversation's own ACL. It used to
   * require `tickets:edit` with no record check, which got the boundary wrong in
   * both directions: a ticket agent could mint a survey token for a conversation
   * they were not allowed to read, and an omni agent with no ticket rights could
   * not mint one for their own conversation.
   */
  @ApiBearerAuth()
  @RequirePermission('edit', 'omni_channel')
  @UseAcl('edit', 'omni_channel')
  @LoadResource('omni_channel')
  @Post('generate-token/:conversationId')
  @ApiOperation({ summary: 'Generate CSAT survey token for a conversation' })
  async generateToken(@Param('conversationId') conversationId: string) {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    const token = await this.csatService.generateToken(
      conversationId,
      tenantId,
    );
    if (!token) throw new NotFoundException('Conversation not found');
    return token;
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
