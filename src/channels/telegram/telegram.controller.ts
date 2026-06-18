import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Headers,
  RawBody,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Unprotected } from 'nest-keycloak-connect';
import { RequirePermission } from '../../common/permissions/permission.decorator';
import { TelegramService } from './telegram.service';
import { IsString, IsOptional, MaxLength } from 'class-validator';

export class CreateTelegramChannelDto {
  @IsString()
  name: string;

  @IsString()
  @MaxLength(500)
  botToken: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;
}

@ApiTags('Telegram')
@Controller({ path: 'channels/telegram', version: '1' })
export class TelegramController {
  constructor(private readonly telegramService: TelegramService) {}

  // ── Channel CRUD ─────────────────────────────────────────────────────────

  @Post()
  @ApiOperation({ summary: 'Create a Telegram Bot channel' })
  @RequirePermission('create', 'channels')
  create(@Body() dto: CreateTelegramChannelDto) {
    return this.telegramService.createChannel(dto);
  }

  // ── Webhook ───────────────────────────────────────────────────────────────

  /**
   * Telegram delivers updates to this URL via HTTPS webhook.
   * Path must be registered with Telegram via setWebhook().
   *
   * @see https://core.telegram.org/bots/api#setwebhook
   */
  @Post('webhook/:channelId')
  @Unprotected()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive Telegram webhook update' })
  async handleWebhook(
    @Param('channelId') channelId: string,
    @Body() update: any,
    @Headers() headers: Record<string, string>,
    @RawBody() rawBody: Buffer,
  ) {
    try {
      await this.telegramService.handleInbound(
        channelId,
        update,
        headers,
        rawBody,
      );
      return { ok: true };
    } catch (err: any) {
      // Always return 200 to Telegram — errors should not cause webhook retries
      return { ok: false, error: err.message };
    }
  }

  /**
   * Register the webhook URL for a Telegram channel.
   * Calls Telegram Bot API setWebhook() using the channel's bot token.
   */
  @Post(':channelId/set-webhook')
  @ApiOperation({ summary: 'Register webhook URL with Telegram' })
  @RequirePermission('edit', 'channels')
  setWebhook(
    @Param('channelId') channelId: string,
    @Body('webhookUrl') webhookUrl: string,
  ) {
    if (!webhookUrl) throw new BadRequestException('webhookUrl is required');
    return this.telegramService.setWebhook(channelId, webhookUrl);
  }

  /**
   * Get bot info (getMe) to verify the token is valid.
   */
  @Get(':channelId/bot-info')
  @ApiOperation({ summary: 'Verify bot token and get bot details' })
  @RequirePermission('view', 'channels')
  getBotInfo(@Param('channelId') channelId: string) {
    return this.telegramService.getBotInfo(channelId);
  }
}
