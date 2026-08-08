import { Inject, Injectable } from '@nestjs/common';
import {
  CHANNEL_ADAPTERS,
  ChannelAdapter,
} from '../../omni-inbound/adapters/channel-adapter.interface';
import { ChannelType } from '../../omni-inbound/domain/omni-payload';
import { ChannelRepository } from '../../channels/infrastructure/persistence/document/repositories/channel.repository';
import { WhatsAppChannelConfig } from '../domain/campaign-channel';
import { TemplateVariableRegistryService } from '../../templates/services/template-variable-registry.service';
import {
  CampaignAbortError,
  CampaignSendSession,
  CampaignSender,
  MergeValues,
  SendOutcome,
} from './campaign-sender';

/**
 * WhatsApp broadcast, as a pre-approved template.
 *
 * Templates are the only legitimate way to open a conversation, so this sender
 * has no text mode: Meta's 24-hour window forbids free-form text to anyone who
 * has not messaged recently, and `sendTemplate` is the documented exception.
 *
 * No conversation is created here. A reply arrives at the existing inbound
 * webhook, which creates the conversation and resolves the contact exactly as it
 * does for any other inbound message — whereas pre-creating one empty
 * conversation per recipient would flood every agent's inbox.
 */
@Injectable()
export class CampaignWhatsAppSender implements CampaignSender {
  readonly channel = 'whatsapp' as const;

  constructor(
    @Inject(CHANNEL_ADAPTERS)
    private readonly adapters: Map<ChannelType, ChannelAdapter>,
    private readonly channels: ChannelRepository,
    private readonly variableRegistry: TemplateVariableRegistryService,
  ) {}

  async open(
    tenantId: string,
    config: WhatsAppChannelConfig,
  ): Promise<CampaignSendSession> {
    const channel = await this.channels.findByIdWithCredentials(
      tenantId,
      config.channelId,
    );

    if (!channel || channel.type !== 'whatsapp') {
      throw new CampaignAbortError(
        'The WhatsApp channel for this campaign no longer exists.',
      );
    }
    if (!channel.credentials?.accessToken || !channel.account) {
      throw new CampaignAbortError(
        'The WhatsApp channel for this campaign is not connected.',
      );
    }

    const adapter = this.adapters.get('whatsapp');
    if (!adapter?.sendTemplate) {
      throw new CampaignAbortError(
        'WhatsApp template sending is unavailable on this deployment.',
      );
    }

    // Resolved once per batch: credentials are stored encrypted and
    // `findByIdWithCredentials` decrypts on every call, so doing this per
    // recipient would put a decrypt and a database round trip in front of each
    // message.
    const channelConfig = {
      credentials: channel.credentials,
      account: channel.account,
    };

    return {
      send: (destination, merge) =>
        this.deliver({
          adapter,
          channelConfig,
          config,
          destination,
          merge,
        }),
    };
  }

  private async deliver(params: {
    adapter: ChannelAdapter;
    channelConfig: { credentials: unknown; account: string };
    config: WhatsAppChannelConfig;
    destination: string;
    merge: MergeValues;
  }): Promise<SendOutcome> {
    const { config, merge } = params;

    const result = await params.adapter.sendTemplate!(
      // The ledger stores E.164 so it matches `contact_identities.normalisedValue`
      // and the bounce lookup, but the Cloud API addresses subscribers by bare
      // digits — the same form its own webhooks deliver.
      params.destination.replace(/^\+/, ''),
      config.templateName,
      config.languageCode,
      this.buildComponents(config, merge),
      params.channelConfig,
    );

    return { providerMessageId: result?.message_id ?? null };
  }

  private buildComponents(
    config: WhatsAppChannelConfig,
    merge: MergeValues,
  ): any[] {
    if (!config.bodyParams?.length) return [];

    return [
      {
        type: 'body',
        parameters: config.bodyParams.map((param) => ({
          type: 'text',
          // An empty parameter is rejected by the provider for the whole message,
          // so a merge tag that resolved to nothing becomes an en dash rather
          // than losing the send.
          text:
            this.variableRegistry.render(param, merge, {
              mode: 'strict',
              purpose: 'campaign',
            }) || '—',
        })),
      },
    ];
  }
}
