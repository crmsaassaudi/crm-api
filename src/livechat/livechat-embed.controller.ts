import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';
import { join } from 'path';
import { existsSync } from 'fs';
import { Public } from '../auth/decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';
import { ChannelConfigService } from '../channels/channel-config.service';
import { ConversationRepository } from '../omni-inbound/repositories/conversation.repository';
import { MessageRepository } from '../omni-inbound/repositories/message.repository';
import { FilesService } from '../files/files.service';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';

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
  ) {}

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
    const widgetUrl = process.env.LIVECHAT_WIDGET_URL
      ?? 'https://livechat.crmsaudi.dev/widget/livechat.iife.js';
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
  @Get('preview/:channelId')
  @ApiOperation({ summary: 'Admin preview page for livechat widget' })
  previewPage(
    @Param('channelId') channelId: string,
    @Res() res: Response,
  ): void {
    const apiUrl = process.env.APP_URL ?? '';
    const widgetUrl = process.env.LIVECHAT_WIDGET_URL
      ?? 'https://livechat.crmsaudi.dev/widget/livechat.iife.js';
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
    <h2>🗨️ Widget Preview</h2>
    <p>The chat bubble appears in the bottom-right corner.</p>
    <p style="font-size:0.75rem;color:#94a3b8;">channelId: ${channelId}</p>
  </div>
  <script>
    window.CRMWidget = {
      channelId: "${channelId}",
      tenantId:  "preview",
      apiUrl:    "${apiUrl}",
      greeting:  "Hi there 👋 How can we help?",
    };
  </script>
  <script src="${widgetUrl}" async></script>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
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
  async getVisitorHistory(
    @Param('channelId') channelId: string,
    @Query('visitorId') visitorId: string,
    @Query('tenantId') tenantId: string,
    @Query('limit') limitStr = '30',
  ) {
    if (!visitorId || !tenantId) {
      throw new BadRequestException('visitorId and tenantId are required');
    }

    const limit = Math.min(parseInt(limitStr, 10) || 30, 50);

    // Find most recent conversation for this visitor (any status)
    const conv = await this.conversationRepo.findLastByExternalId(
      tenantId,
      'livechat',
      channelId, // channelAccount = channelId for livechat
      visitorId, // externalId = visitorId
    );

    if (!conv) {
      // No conversation yet — return empty (visitor just opened widget for first time)
      return { conversationId: null, messages: [] };
    }

    // Fetch last `limit` messages, oldest-first for display
    const result = await this.messageRepo.findByConversation(conv.id, 1, limit);

    // Resolve presigned URLs for media messages so widget can render them
    const messages = await Promise.all(
      result.data.map(async (msg: any) => {
        if (msg.fileId) {
          try {
            const file = await this.filesService.findById(msg.fileId);
            if (file?.path) {
              const url = await this.filesService.getPresignedDownloadUrl(
                file.path,
                3600,
              );
              return { ...msg, mediaUrl: url };
            }
          } catch {
            /* skip — message still returned without url */
          }
        }
        return msg;
      }),
    );

    return {
      conversationId: conv.id,
      status: conv.status,
      messages,
    };
  }
}
