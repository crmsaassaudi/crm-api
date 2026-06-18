import { Controller, Get, Param, Res, NotFoundException } from '@nestjs/common';
import { Response } from 'express';
import { join } from 'path';
import { existsSync } from 'fs';
import { Public } from '../auth/decorators/public.decorator';
import { ChannelConfigService } from '../channels/channel-config.service';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

/**
 * LivechatEmbedController — public endpoints for widget distribution.
 *
 * GET /livechat/widget.js            → serve built widget JS (from public/widget/)
 * GET /livechat/embed/:channelId     → generate embed snippet for a channel
 * GET /livechat/preview/:channelId   → HTML preview page for admin settings
 */
@ApiTags('Livechat Widget')
@Controller('livechat')
export class LivechatEmbedController {
  constructor(private readonly channelConfigService: ChannelConfigService) {}

  /**
   * Serve the built widget JS file.
   * Cached aggressively in production (versioned by channelId query param).
   */
  @Public()
  @Get('widget.js')
  @ApiOperation({ summary: 'Serve the livechat widget bundle' })
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
        'Widget bundle not found. Run `npm run build` in livechat-widget/ first.',
      );
    }

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(filePath);
  }

  /**
   * Returns the embed snippet for a specific channel.
   * Used by the admin Settings → Channels → Livechat page.
   */
  @Get('embed/:channelId')
  @ApiOperation({ summary: 'Get embed snippet for a livechat channel' })
  async getEmbedSnippet(
    @Param('channelId') channelId: string,
    @Res() res: Response,
  ): Promise<void> {
    const channel = await this.channelConfigService.findById(channelId);
    if (!channel) throw new NotFoundException('Channel not found');

    const apiUrl = process.env.APP_URL ?? 'https://api.yourcrm.com';
    const tenantId = (channel as any).tenantId ?? '';
    const color = (channel as any).brandColor ?? '#6366f1';
    const greeting =
      (channel as any).greeting ?? 'Hi there 👋 How can we help you today?';
    const agentName = (channel as any).agentName ?? 'Support Team';

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
<script src="${apiUrl}/livechat/widget.js" async defer></script>
<!-- End CRM Livechat Widget -->`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(snippet);
  }

  /**
   * Preview page — iframed in the admin channel settings for visual preview.
   */
  @Public()
  @Get('preview/:channelId')
  @ApiOperation({ summary: 'Admin preview page for livechat widget' })
  previewPage(
    @Param('channelId') channelId: string,
    @Res() res: Response,
  ): void {
    const apiUrl = process.env.APP_URL ?? '';
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
  <script src="${apiUrl}/livechat/widget.js" async></script>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }
}
