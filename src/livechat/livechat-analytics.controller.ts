import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { WidgetEventRepository } from './infrastructure/persistence/document/repositories/widget-event.repository';
import { LivechatWidgetService } from './livechat-widget.service';

@ApiTags('Livechat Analytics')
@Controller({ path: 'livechat/analytics', version: '1' })
export class LivechatAnalyticsController {
  constructor(
    private readonly eventRepo: WidgetEventRepository,
    private readonly widgetService: LivechatWidgetService,
  ) {}

  // ── Public: Widget fires events here (no auth, fire-and-forget) ──────────

  @Public()
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Post('events')
  @HttpCode(204)
  @ApiOperation({ summary: 'Track widget analytics event' })
  async trackEvent(
    @Body()
    body: {
      widgetId: string;
      event: string;
      data?: Record<string, any>;
      visitorId?: string;
      sessionId?: string;
      pageUrl?: string;
    },
    @Req() req: any,
  ): Promise<void> {
    if (!body.widgetId || !body.event) return;

    // Resolve tenantId from widget (cached in production)
    const config = await this.widgetService.getPublicConfig(body.widgetId);
    if (!config) return; // Invalid widget — silently ignore

    // Extract domain from origin
    const origin = req.headers?.origin || req.headers?.referer;
    let domain: string | undefined;
    try { domain = new URL(origin).hostname; } catch { /* ignore */ }

    const isMobile = /Mobile|Android|iPhone/i.test(
      req.headers?.['user-agent'] || '',
    );

    await this.eventRepo.track({
      widgetId: body.widgetId,
      tenantId: config.tenantId,
      event: body.event,
      data: body.data,
      visitorId: body.visitorId,
      sessionId: body.sessionId,
      pageUrl: body.pageUrl,
      domain,
      isMobile,
    });
  }

  @Public()
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Post('events/batch')
  @HttpCode(204)
  @ApiOperation({ summary: 'Track multiple widget analytics events' })
  async trackBatch(
    @Body()
    body: {
      widgetId: string;
      events: Array<{
        event: string;
        data?: Record<string, any>;
        visitorId?: string;
        pageUrl?: string;
      }>;
    },
    @Req() req: any,
  ): Promise<void> {
    if (!body.widgetId || !body.events?.length) return;

    const config = await this.widgetService.getPublicConfig(body.widgetId);
    if (!config) return;

    const origin = req.headers?.origin || req.headers?.referer;
    let domain: string | undefined;
    try { domain = new URL(origin).hostname; } catch { /* ignore */ }
    const isMobile = /Mobile|Android|iPhone/i.test(
      req.headers?.['user-agent'] || '',
    );

    await this.eventRepo.trackBatch(
      body.events.map((e) => ({
        widgetId: body.widgetId,
        tenantId: config.tenantId,
        event: e.event,
        data: e.data,
        visitorId: e.visitorId,
        pageUrl: e.pageUrl,
        domain,
        isMobile,
      })),
    );
  }

  // ── Admin: Dashboard queries ─────────────────────────────────────────────

  @Get(':widgetId/summary')
  @ApiOperation({ summary: 'Get widget analytics summary' })
  async getSummary(
    @Param('widgetId') widgetId: string,
    @Query('days') days?: string,
  ) {
    const d = parseInt(days || '30', 10);
    const to = new Date();
    const from = new Date(to.getTime() - d * 24 * 60 * 60 * 1000);

    const [summary, dailyImpressions, dailyOpens, dailyChats, topPages] =
      await Promise.all([
        this.eventRepo.getSummary(widgetId, { from, to }),
        this.eventRepo.dailyCounts(widgetId, 'widget.impression', { from, to }),
        this.eventRepo.dailyCounts(widgetId, 'widget.open', { from, to }),
        this.eventRepo.dailyCounts(widgetId, 'widget.conversation_started', { from, to }),
        this.eventRepo.topPages(widgetId, { from, to }),
      ]);

    const impressions = summary['widget.impression'] ?? 0;
    const opens = summary['widget.open'] ?? 0;
    const chats = summary['widget.conversation_started'] ?? 0;

    return {
      period: { from, to, days: d },
      totals: {
        impressions,
        opens,
        chats,
        csatSubmitted: summary['widget.csat_submitted'] ?? 0,
      },
      rates: {
        clickRate: impressions ? +(opens / impressions * 100).toFixed(1) : 0,
        engagementRate: opens ? +(chats / opens * 100).toFixed(1) : 0,
      },
      daily: {
        impressions: dailyImpressions,
        opens: dailyOpens,
        chats: dailyChats,
      },
      topPages,
    };
  }
}
