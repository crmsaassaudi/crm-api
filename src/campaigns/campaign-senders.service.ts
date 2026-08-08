import { BadRequestException, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ChannelConfigService } from '../channels/channel-config.service';
import { ChannelRepository } from '../channels/infrastructure/persistence/document/repositories/channel.repository';
import { CampaignChannel } from './domain/campaign-channel';

/** One selectable sender, as the wizard's dropdown needs it. */
export interface CampaignSenderOption {
  /** `configId` for email and SMS, `channelId` for WhatsApp. */
  id: string;
  name: string;
  /** The address or number messages will appear to come from. */
  detail?: string;
  /** False when the provider is disconnected or reporting errors. */
  usable: boolean;
}

/**
 * What a campaign can send from, per channel.
 *
 * A campaign-owned endpoint rather than three calls to the settings APIs,
 * because the wizard's question is narrower than theirs: not "what integrations
 * exist" but "which of them can carry a broadcast". SendGrid configs, livechat
 * channels and Facebook pages all exist and none of them belong in this list.
 *
 * Credentials never appear here — only the id the campaign stores and enough
 * detail for a human to recognise the account.
 */
@Injectable()
export class CampaignSendersService {
  constructor(
    private readonly channelConfigs: ChannelConfigService,
    private readonly channels: ChannelRepository,
    private readonly cls: ClsService,
  ) {}

  async list(channel: CampaignChannel): Promise<CampaignSenderOption[]> {
    if (channel === 'whatsapp') return this.whatsappChannels();

    const providerType = channel === 'email' ? 'smtp' : 'twilio';
    const configs = await this.channelConfigs.findAll();

    return configs
      .filter((config) => config.providerType === providerType)
      .map((config) => ({
        id: String(config.id),
        name: config.name,
        detail:
          channel === 'email'
            ? (config.publicSettings?.fromEmail as string | undefined)
            : (config.publicSettings?.fromNumber as string | undefined),
        // Surfaced rather than filtered out: a sender that is failing health
        // checks is exactly what someone needs to see when their campaign will
        // not launch, and hiding it makes the list look empty for no reason.
        usable: config.status === 'active',
      }));
  }

  private async whatsappChannels(): Promise<CampaignSenderOption[]> {
    const tenantId =
      this.cls.get<string>('activeTenantId') ??
      this.cls.get<string>('tenantId');
    if (!tenantId) throw new BadRequestException('Tenant context is required.');

    const all = await this.channels.findAll(tenantId);
    return all
      .filter((channel) => channel.type === 'whatsapp')
      .map((channel) => ({
        id: String(channel.id),
        name: channel.name,
        detail: channel.account,
        usable: channel.status === 'active',
      }));
  }
}
