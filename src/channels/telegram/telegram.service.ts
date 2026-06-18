import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import axios from 'axios';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ChannelRepository } from '../infrastructure/persistence/document/repositories/channel.repository';
import { TelegramAdapter } from './telegram.adapter';
import { CreateTelegramChannelDto } from './telegram.controller';

const TG_API = (token: string) => `https://api.telegram.org/bot${token}`;

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(
    private readonly channelRepo: ChannelRepository,
    private readonly adapter: TelegramAdapter,
    private readonly cls: ClsService,
    private readonly events: EventEmitter2,
  ) {}

  // ── Channel creation ────────────────────────────────────────────────────────

  async createChannel(dto: CreateTelegramChannelDto) {
    const tenantId = this.cls.get('tenantId');

    // Verify the token first
    let botInfo: any;
    try {
      const res = await axios.get(`${TG_API(dto.botToken)}/getMe`, {
        timeout: 8_000,
      });
      botInfo = res.data?.result;
      if (!botInfo) throw new Error('Invalid response');
    } catch (err: any) {
      throw new NotFoundException(`Invalid Telegram bot token: ${err.message}`);
    }

    const account = `tg_${botInfo.id}`;

    const { channel } = await this.channelRepo.upsert(
      tenantId,
      'telegram',
      account,
      {
        tenantId,
        type: 'telegram' as any,
        name: dto.name,
        account,
        status: 'Connected',
        config: {
          botUsername: botInfo.username,
          botName: botInfo.first_name,
          description: dto.description ?? '',
          webhookRegistered: false,
        },
        credentials: {
          botToken: dto.botToken,
        },
      },
    );

    this.logger.log(
      `Telegram channel created: @${botInfo.username} (tenantId=${tenantId})`,
    );
    return { ...channel, botInfo };
  }

  // ── Webhook handling ────────────────────────────────────────────────────────

  async handleInbound(
    channelId: string,
    update: any,
    headers: Record<string, string>,
    rawBody: Buffer,
  ): Promise<void> {
    const channel = await this.channelRepo.findByIdNoTenant(channelId);
    if (!channel) {
      this.logger.warn(`Telegram webhook for unknown channel ${channelId}`);
      return;
    }

    const channelConfig = {
      credentials: channel.credentials,
      config: channel.config,
      account: channel.account,
    };

    // Validate webhook secret
    const valid = this.adapter.validateWebhook(headers, update, rawBody);
    if (!valid) {
      this.logger.warn(
        `Telegram webhook validation failed for channel ${channelId}`,
      );
      return;
    }

    const payload = this.adapter.normalize(
      update,
      channel.tenantId,
      channelId,
      channelConfig,
    );
    if (!payload) return;

    // Emit into the omni-inbound pipeline
    this.events.emit('omni.inbound.message', { payload, channelConfig });
    this.logger.debug(
      `Telegram inbound emitted: type=${payload.messageType} from=${payload.senderId}`,
    );
  }

  // ── Register webhook with Telegram ─────────────────────────────────────────

  async setWebhook(channelId: string, webhookUrl: string) {
    const channel = await this.channelRepo.findByIdNoTenant(channelId);
    if (!channel) throw new NotFoundException(`Channel ${channelId} not found`);

    const token = (channel.credentials as any)?.botToken;
    if (!token) throw new NotFoundException('Bot token not configured');

    const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET;

    const body: Record<string, any> = { url: webhookUrl };
    if (secretToken) body.secret_token = secretToken;

    const res = await axios.post(`${TG_API(token)}/setWebhook`, body, {
      timeout: 10_000,
    });

    if (!res.data?.ok) {
      throw new Error(`Telegram setWebhook failed: ${res.data?.description}`);
    }

    // Mark webhook as registered in channel config
    await this.channelRepo.update(channel.id ?? channelId, channel.tenantId, {
      config: {
        ...(channel.config as any),
        webhookRegistered: true,
        webhookUrl,
      },
    } as any);

    this.logger.log(
      `Telegram webhook registered for channel ${channelId}: ${webhookUrl}`,
    );
    return { ok: true, webhookUrl };
  }

  // ── Bot info ────────────────────────────────────────────────────────────────

  async getBotInfo(channelId: string) {
    const channel = await this.channelRepo.findByIdNoTenant(channelId);
    if (!channel) throw new NotFoundException(`Channel ${channelId} not found`);

    const token = (channel.credentials as any)?.botToken;
    if (!token) throw new NotFoundException('Bot token not configured');

    const res = await axios.get(`${TG_API(token)}/getMe`, { timeout: 8_000 });
    return res.data?.result;
  }
}
