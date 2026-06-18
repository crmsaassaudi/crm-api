import { Module } from '@nestjs/common';
import { TelegramAdapter } from './telegram.adapter';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { ChannelsModule } from '../channels.module';

/**
 * TelegramModule — Telegram Bot API integration.
 *
 * Provides:
 *  - TelegramAdapter (registered in OmniInboundModule's adapter map)
 *  - TelegramController (POST /channels/telegram, webhook, setWebhook, botInfo)
 *  - TelegramService (channel CRUD + inbound pipeline)
 */
@Module({
  imports: [ChannelsModule],
  controllers: [TelegramController],
  providers: [TelegramAdapter, TelegramService],
  exports: [TelegramAdapter],
})
export class TelegramModule {}
