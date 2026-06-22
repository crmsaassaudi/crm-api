import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  Req,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';
import { join } from 'path';
import { existsSync } from 'fs';
import { Public } from '../auth/decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';
import { ClsService } from 'nestjs-cls';
import { ChannelConfigService } from '../channels/channel-config.service';
import { ConversationRepository } from '../omni-inbound/repositories/conversation.repository';
import { MessageRepository } from '../omni-inbound/repositories/message.repository';
import { FilesService } from '../files/files.service';
import { LivechatWidgetService } from './livechat-widget.service';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { runWithTenantContext } from '../common/tenancy/tenant-context';

/**
 * LivechatEmbedController — public endpoints for widget distribution.
 *
 * GET /livechat/widget.js               → serve built widget JS
 * GET /livechat/embed/:channelId        → embed snippet for admin
 * GET /livechat/preview/:channelId      → HTML preview page
 * GET /livechat/history/:channelId      → message history for visitor (public, P1.3)
 */
@ApiTags('Livechat Widget')
@Controller({ path: 'livechat', version: '1' })
export class LivechatEmbedController {
  constructor(
    private readonly channelConfigService: ChannelConfigService,
    private readonly conversationRepo: ConversationRepository,
    private readonly messageRepo: MessageRepository,
    private readonly filesService: FilesService,
    private readonly widgetService: LivechatWidgetService,
    private readonly cls: ClsService,
  ) {}

  // ── Public widget config (loaded by embed JS) ───────────────────────────

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('config/:widgetId')
  @ApiOperation({ summary: 'Get public widget config by widgetId' })
  async getWidgetConfig(
    @Param('widgetId') widgetId: string,
    @Req() req: any,
    @Res() res: Response,
  ): Promise<void> {
    // PERF FIX #8: Load widget once — isDomainAllowed and getPublicConfig
    // both called repo.findByWidgetId separately (2 identical DB queries).
    // Now we load once and pass the preloaded entity to both methods.
    const origin = req.headers?.origin || req.headers?.referer;
    const { allowed, config } =
      await this.widgetService.getDomainCheckAndConfig(widgetId, origin);

    if (!allowed) {
      res.status(403).json({
        statusCode: 403,
        message: 'Domain not allowed for this widget',
      });
      return;
    }

    if (!config) {
      throw new NotFoundException('Widget not found or paused');
    }

    // Set CORS to the requesting origin (not wildcard) when whitelist is active
    const corsOrigin = origin ? new URL(origin).origin : '*';
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(config);
  }

  // ── Widget bundle ────────────────────────────────────────────────────────
  // NOTE: Widget JS is served from Node E (livechat.crmsaudi.dev), NOT from
  // this API server. The serveWidget endpoint below is kept only as a
  // development fallback. In production, the script src in embed snippets
  // points to LIVECHAT_WIDGET_URL.

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('widget.js')
  @ApiOperation({ summary: 'Serve the livechat widget bundle (dev fallback)' })
  serveWidget(@Res() res: Response): void {
    const widgetPath = join(
      process.cwd(),
      'public',
      'widget',
      'livechat.iife.js',
    );
    const fallback = join(process.cwd(), 'public', 'widget', 'livechat.js');

    const filePath = existsSync(widgetPath) ? widgetPath : fallback;

    if (!existsSync(filePath)) {
      throw new NotFoundException(
        'Widget bundle not found. In production, use LIVECHAT_WIDGET_URL instead.',
      );
    }

    // Widget is embedded on external websites — override helmet's same-origin defaults
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.sendFile(filePath);
  }

  // ── Embed snippet ────────────────────────────────────────────────────────

  @Get('embed/:channelId')
  @ApiOperation({ summary: 'Get embed snippet for a livechat channel' })
  async getEmbedSnippet(
    @Param('channelId') channelId: string,
    @Res() res: Response,
  ): Promise<void> {
    const channel = await this.channelConfigService.findById(channelId);
    if (!channel) throw new NotFoundException('Channel not found');

    const apiUrl = process.env.APP_URL ?? 'https://api.yourcrm.com';
    const widgetUrl =
      process.env.LIVECHAT_WIDGET_URL ??
      'https://livechat.crmsaudi.dev/widget/livechat.iife.js';
    const tenantId = (channel as any).tenantId ?? '';

    // FIX: Settings are stored in channel.config (JSONB), NOT top-level fields.
    // Reading top-level always returned undefined → defaults were used every time.
    const cfg = (channel as any).config ?? {};
    const color = cfg.brandColor ?? '#6366f1';
    const greeting = cfg.greeting ?? 'Hi there 👋 How can we help you today?';
    const agentName = cfg.agentName ?? 'Support Team';

    const snippet = `<!-- CRM Livechat Widget -->
<script>
  window.CRMWidget = {
    channelId:    "${channelId}",
    tenantId:     "${tenantId}",
    apiUrl:       "${apiUrl}",
    primaryColor: "${color}",
    greeting:     "${greeting}",
    agentName:    "${agentName}",
  };
</script>
<script src="${widgetUrl}" async defer></script>
<!-- End CRM Livechat Widget -->`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(snippet);
  }

  // ── Admin preview page ───────────────────────────────────────────────────

  @Public()
  @Get('preview/:widgetId')
  @ApiOperation({
    summary: 'Admin preview page for livechat widget (by widgetId)',
  })
  async previewPage(
    @Param('widgetId') widgetId: string,
    @Res() res: Response,
  ): Promise<void> {
    const apiUrl = process.env.APP_URL ?? '';
    const widgetUrl =
      process.env.LIVECHAT_WIDGET_URL ??
      'https://livechat.crmsaudi.dev/widget/livechat.iife.js';

    // Try to load widget config for richer preview
    let widgetConfig: Record<string, any> = {};
    try {
      const cfg = await this.widgetService.getPublicConfig(widgetId);
      if (cfg) widgetConfig = cfg as any;
    } catch {
      /* widget may not exist yet — still render preview shell */
    }

    const initConfig = JSON.stringify({
      widgetId,
      apiUrl,
      ...widgetConfig,
    });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Widget Preview</title>
  <style>
    body { margin: 0; min-height: 100vh; background: #f8fafc;
           font-family: sans-serif; display: flex; align-items: center; justify-content: center; }
    .demo { color: #64748b; text-align: center; }
    h2 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p  { font-size: 0.875rem; }
  </style>
</head>
<body>
  <div class="demo">
    <h2>&#x1F4E8; Widget Preview</h2>
    <p>The chat bubble appears in the bottom-right corner.</p>
    <p style="font-size:0.75rem;color:#94a3b8;">widgetId: ${widgetId}</p>
  </div>
  <script>
    window.CRMWidget = ${initConfig};
    // Listen for config updates from parent (settings panel)
    window.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'CRM_WIDGET_CONFIG_UPDATE') {
        window.CRMWidget = Object.assign(window.CRMWidget || {}, e.data.config);
        if (window.CRMWidgetInstance && window.CRMWidgetInstance.updateConfig) {
          window.CRMWidgetInstance.updateConfig(e.data.config);
        }
      }
    });
  </script>
  <script src="${widgetUrl}" async></script>
</body>
</html>`;
    // Allow iframe embedding from any origin (admin preview)
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', 'frame-ancestors *');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }

  // ── Standalone chat page (direct URL access) ─────────────────────────────

  /**
   * GET /livechat/chat/:widgetId
   *
   * A public, standalone HTML page that renders the livechat widget fullscreen.
   * Visitors can access this URL directly — no website embedding required.
   *
   * The widget auto-opens immediately on page load (autoOpen = true).
   *
   * Use cases:
   *  - Share a direct chat link via email / QR code
   *  - WhatsApp "Chat with us" button pointing here
   *  - Mobile shortcut / PWA-like experience
   */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('chat/:widgetId')
  @ApiOperation({
    summary: 'Standalone fullscreen chat page for direct URL sharing',
  })
  async standaloneChatPage(
    @Param('widgetId') widgetId: string,
    @Res() res: Response,
  ): Promise<void> {
    const apiUrl = process.env.APP_URL ?? '';
    const widgetUrl =
      process.env.LIVECHAT_WIDGET_URL ??
      'https://livechat.crmsaudi.dev/widget/livechat.iife.js';

    // Load widget config for branding (company name, colors, etc.)
    let widgetConfig: Record<string, any> = {};
    try {
      const cfg = await this.widgetService.getPublicConfig(widgetId);
      if (cfg) widgetConfig = cfg as any;
    } catch {
      /* render generic page if widget not found */
    }

    const companyName: string =
      widgetConfig?.branding?.companyName ?? 'Support';
    const primaryColor: string = widgetConfig?.theme?.primaryColor ?? '#6366f1';
    const greeting: string =
      widgetConfig?.welcome?.greeting ?? 'Hi there 👋 How can we help?';
    const logoUrl: string = widgetConfig?.branding?.logo ?? '';

    // Pass widgetId + autoOpen so widget opens immediately
    const initConfig = JSON.stringify({
      widgetId,
      apiUrl,
      ...widgetConfig,
      // Force widget open on load — override any saved state
      welcome: {
        ...(widgetConfig?.welcome ?? {}),
        autoOpenDelay: 1,
      },
    });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="${primaryColor}" />
  <title>Chat with ${companyName}</title>
  <meta name="description" content="Start a live chat with ${companyName} support team." />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      min-height: 100dvh;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, ${primaryColor}18 0%, #f8fafc 60%);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 24px;
      padding: 24px;
    }

    .brand {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      text-align: center;
      animation: fadeUp 0.5s ease both;
    }

    .brand-logo {
      width: 64px;
      height: 64px;
      border-radius: 16px;
      object-fit: cover;
      box-shadow: 0 4px 16px rgba(0,0,0,0.12);
    }

    .brand-logo-placeholder {
      width: 64px;
      height: 64px;
      border-radius: 16px;
      background: ${primaryColor};
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      box-shadow: 0 4px 16px ${primaryColor}40;
    }

    .brand-name {
      font-size: 1.5rem;
      font-weight: 700;
      color: #0f172a;
    }

    .brand-greeting {
      font-size: 0.95rem;
      color: #64748b;
      max-width: 320px;
      line-height: 1.5;
    }

    .hint {
      font-size: 0.78rem;
      color: #94a3b8;
      animation: fadeUp 0.5s 0.3s ease both;
    }

    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(12px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <div class="brand">
    ${
      logoUrl
        ? `<img src="${logoUrl}" alt="${companyName}" class="brand-logo" />`
        : `<div class="brand-logo-placeholder">💬</div>`
    }
    <div class="brand-name">${companyName}</div>
    <div class="brand-greeting">${greeting}</div>
  </div>
  <p class="hint">Opening chat…</p>

  <script>
    window.CRMWidget = ${initConfig};
  </script>
  <script src="${widgetUrl}" async></script>
  <script>
    // Auto-open widget once SDK is ready
    (function waitForWidget() {
      if (window.CRMWidget && typeof window.CRMWidget.open === 'function') {
        window.CRMWidget.open();
      } else {
        setTimeout(waitForWidget, 100);
      }
    })();
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(html);
  }

  // ── P1.3: Message history for widget (public, visitorId-scoped) ──────────

  /**
   * GET /livechat/history/:channelId?visitorId=&tenantId=&limit=
   *
   * Returns the last N messages from the visitor's active (or most recent)
   * conversation. This endpoint is public — visitor identity is proven by
   * knowing (visitorId + channelId + tenantId) which are stored in the
   * widget's localStorage.
   *
   * Security: these IDs are not guessable (visitorId = random UUID generated
   * client-side and stored in localStorage). The endpoint returns at most
   * `limit` messages and no sensitive agent data beyond display name.
   *
   * Used by widget on reconnect to restore chat history without requiring
   * agent authentication.
   */
  @Public()
  // Task C: Rate-limit to prevent conversation enumeration.
  // visitorId is a UUID (not guessable), but throttling adds defence-in-depth.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('history/:channelId')
  @ApiOperation({
    summary: 'Get message history for a livechat visitor (widget use only)',
  })
  @ApiQuery({ name: 'visitorId', required: true })
  @ApiQuery({ name: 'tenantId', required: true })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max 50, default 30',
  })
  @ApiQuery({
    name: 'after',
    required: false,
    description:
      'ISO timestamp — return only messages after this time (cursor-based incremental fetch)',
  })
  async getVisitorHistory(
    @Param('channelId') channelId: string,
    @Query('visitorId') visitorId: string,
    @Query('tenantId') tenantId: string,
    @Query('limit') limitStr = '30',
    @Req() req: any,
    @Res() res: Response,
    @Query('after') afterStr?: string,
  ) {
    if (!visitorId || !tenantId) {
      throw new BadRequestException('visitorId and tenantId are required');
    }

    const limit = Math.min(parseInt(limitStr, 10) || 30, 50);

    // CORS — widget is embedded on external websites
    const origin = req.headers?.origin || req.headers?.referer;
    const corsOrigin = origin ? new URL(origin).origin : '*';
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    // Public endpoint — no auth/interceptor sets CLS.
    // Set CLS manually so Mongoose tenant filter plugin works.
    const conv = await runWithTenantContext(this.cls, tenantId, () =>
      this.conversationRepo.findLastByExternalId(
        tenantId,
        'livechat',
        channelId,
        visitorId,
      ),
    );

    if (!conv) {
      // No conversation yet — return empty (visitor just opened widget for first time)
      res.json({ conversationId: null, messages: [] });
      return;
    }

    // Parse `after` cursor for incremental fetch (reconnect optimization).
    // When provided, only messages created AFTER this timestamp are returned,
    // preventing full history reload on every reconnect.
    const afterDate = afterStr ? new Date(afterStr) : null;
    const useIncremental = afterDate && !isNaN(afterDate.getTime());

    let rawMessages: any[];

    if (useIncremental) {
      // Cursor-based: fetch only messages newer than `after`
      const cursorResult = await runWithTenantContext(this.cls, tenantId, () =>
        this.messageRepo.findByConversationIdWithCursor({
          conversationId: conv.id,
          limit,
          direction: 'future',
          cursor: { createdAt: afterDate, id: '' },
        }),
      );
      rawMessages = cursorResult.data;
    } else {
      // Full fetch (first load) — PERF FIX #7: use findRecentByConversation
      // which skips countDocuments (widget doesn't need total count)
      const result = await runWithTenantContext(this.cls, tenantId, () =>
        this.messageRepo.findRecentByConversation(conv.id, limit),
      );
      rawMessages = result.data;
    }

    // PERF FIX #1: Batch-load files instead of N individual findById calls.
    // Previously each media message triggered findById + getPresignedDownloadUrl
    // sequentially (N+1 problem). Now we batch-load all files in one query.
    const fileIds = rawMessages
      .map((msg: any) => msg.fileId)
      .filter(Boolean) as string[];

    const fileMap = new Map<string, { path?: string }>();
    if (fileIds.length > 0) {
      try {
        const files = await this.filesService.findByIds(fileIds);
        for (const f of files) {
          if (f?.id) fileMap.set(f.id.toString(), f);
        }
      } catch {
        /* non-fatal — messages still returned without URLs */
      }
    }

    const messages = await Promise.all(
      rawMessages.map(async (msg: any) => {
        if (msg.fileId) {
          const file = fileMap.get(msg.fileId.toString?.() ?? msg.fileId);
          if (file?.path) {
            try {
              const url = await this.filesService.getPresignedDownloadUrl(
                file.path,
                3600,
              );
              return { ...msg, mediaUrl: url };
            } catch {
              /* skip — message still returned without url */
            }
          }
        }
        return msg;
      }),
    );

    res.json({
      conversationId: conv.id,
      status: conv.status,
      messages,
    });
  }
}
