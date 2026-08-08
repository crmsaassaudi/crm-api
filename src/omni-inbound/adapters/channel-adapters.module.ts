import { Module, forwardRef } from '@nestjs/common';
import { CHANNEL_ADAPTERS, ChannelAdapter } from './channel-adapter.interface';
import { ChannelType } from '../domain/omni-payload';
import { FacebookAdapter } from './facebook.adapter';
import { ZaloAdapter } from './zalo.adapter';
import { WhatsAppAdapter } from './whatsapp.adapter';
import { InstagramAdapter } from './instagram.adapter';
import { LivechatAdapter } from './livechat.adapter';
import { TikTokAdapter } from './tiktok.adapter';
import { TelegramAdapter } from '../../channels/telegram/telegram.adapter';
import { LivechatModule } from '../../livechat/livechat.module';
import { TemplatesModule } from '../../templates/templates.module';

/**
 * ChannelAdaptersModule — the one registry of channel adapters.
 *
 * There were two. `OmniInboundModule` built a map of seven adapters and
 * `OmniOutboundModule` built its own of five, missing `telegram` and `tiktok` —
 * and `OutboundService` resolves `CHANNEL_ADAPTERS` from the outbound module, so
 * a reply on either channel found no adapter. Inbound could receive a Telegram
 * message that outbound could not answer.
 *
 * The duplication existed to avoid a cycle: `OmniInboundModule` imports
 * `OmniOutboundModule`, so the outbound module cannot import the inbound one back.
 * A third module both depend on removes the cycle and the drift together — a
 * channel is now added in exactly one place.
 */
@Module({
  imports: [
    // LivechatAdapter is provided by LivechatModule rather than here: that module
    // calls `setGateway()` on it at boot, and a second instance would be the one
    // without a gateway. forwardRef because LivechatModule reaches back into
    // OmniInboundModule.
    forwardRef(() => LivechatModule),
    // WhatsAppAdapter updates a template's approval status from Meta's webhook.
    TemplatesModule,
  ],
  providers: [
    FacebookAdapter,
    ZaloAdapter,
    WhatsAppAdapter,
    InstagramAdapter,
    TelegramAdapter,
    TikTokAdapter,
    {
      provide: CHANNEL_ADAPTERS,
      useFactory: (
        facebook: FacebookAdapter,
        zalo: ZaloAdapter,
        whatsapp: WhatsAppAdapter,
        instagram: InstagramAdapter,
        livechat: LivechatAdapter,
        telegram: TelegramAdapter,
        tiktok: TikTokAdapter,
      ) => {
        const map = new Map<ChannelType, ChannelAdapter>();
        map.set('facebook', facebook);
        map.set('zalo', zalo);
        map.set('whatsapp', whatsapp);
        map.set('instagram', instagram);
        map.set('livechat', livechat);
        map.set('telegram', telegram);
        map.set('tiktok', tiktok);
        return map;
      },
      inject: [
        FacebookAdapter,
        ZaloAdapter,
        WhatsAppAdapter,
        InstagramAdapter,
        LivechatAdapter,
        TelegramAdapter,
        TikTokAdapter,
      ],
    },
  ],
  exports: [
    CHANNEL_ADAPTERS,
    FacebookAdapter,
    ZaloAdapter,
    WhatsAppAdapter,
    InstagramAdapter,
    TelegramAdapter,
    TikTokAdapter,
  ],
})
export class ChannelAdaptersModule {}
