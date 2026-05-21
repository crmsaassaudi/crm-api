import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { ulid } from 'ulid';
import { ChannelRepository } from './infrastructure/persistence/document/repositories/channel.repository';
import { Channel } from './domain/channel';
import {
  ConnectMetaChannelsDto,
  CreateChannelDto,
  UpdateChannelDto,
} from './dto/channel.dto';
import { RedisService } from '../redis/redis.service';
import { AllConfigType } from '../config/config.type';
import axios from 'axios';

type MetaConnectionType = 'fb' | 'ig' | 'wa' | 'fb_ig';

type MetaOAuthStatePayload = {
  type: MetaConnectionType;
  tenantId: string;
  userId?: string;
  openerOrigin: string;
};

type MetaAvailableChannel = {
  accountId: string;
  pageId?: string;
  name: string;
  category: string;
  type: 'Facebook' | 'Instagram' | 'WhatsApp';
  accessToken: string;
  tokenExpiry?: string | null;
  avatarUrl?: string;
};

type PublicMetaAvailableChannel = Omit<MetaAvailableChannel, 'accessToken'>;

type MetaOAuthResultPayload = MetaOAuthStatePayload & {
  channels: MetaAvailableChannel[];
  createdAt: string;
};

type MetaCallbackParams = {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
};

const META_STATE_PREFIX = 'meta:oauth:state:';
const META_RESULT_PREFIX = 'meta:oauth:result:';
const META_TTL_SECONDS = 10 * 60;

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);

  constructor(
    private readonly repository: ChannelRepository,
    private readonly cls: ClsService,
    private readonly configService: ConfigService<AllConfigType>,
    private readonly redisService: RedisService,
  ) {}

  async findAll(): Promise<Channel[]> {
    const tenantId = this.cls.get('tenantId');
    return this.repository.findAll(tenantId);
  }

  async findById(id: string): Promise<Channel> {
    const tenantId = this.cls.get('tenantId');
    const channel = await this.repository.findById(tenantId, id);
    if (!channel) throw new NotFoundException('Channel not found');
    return channel;
  }

  async findByAccount(type: string, account: string): Promise<Channel> {
    const tenantId = this.cls.get('tenantId');
    const channel = await this.repository.findByAccount(
      tenantId,
      type,
      account,
    );
    if (!channel) throw new NotFoundException('Channel not found');
    return channel;
  }

  async findAnyByAccount(type: string, account: string): Promise<Channel> {
    const channel = await this.repository.findAnyByAccount(type, account);
    if (!channel) throw new NotFoundException('Channel not found');
    return channel;
  }

  async buildMetaAuthUrl(
    rawType: MetaConnectionType = 'fb_ig',
    openerOrigin?: string,
  ): Promise<{ url: string }> {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new BadRequestException('Tenant context is required');
    }

    const type = this.normalizeMetaType(rawType);
    const state = ulid();
    const statePayload: MetaOAuthStatePayload = {
      type,
      tenantId,
      userId: this.cls.get('userId'),
      openerOrigin: this.sanitizeFrontendOrigin(openerOrigin),
    };

    await this.redisService
      .getClient()
      .set(
        `${META_STATE_PREFIX}${state}`,
        JSON.stringify(statePayload),
        'EX',
        META_TTL_SECONDS,
      );

    const params = new URLSearchParams({
      client_id: this.getMetaAppId(),
      redirect_uri: this.getMetaRedirectUri(),
      response_type: 'code',
      state,
    });

    const scope = this.getMetaScopes(type);
    const configId = this.getWhatsAppConfigId(type);

    if (configId) {
      params.set('config_id', configId);
    }
    if (scope) {
      params.set('scope', scope);
    }

    return {
      url: `https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`,
    };
  }

  async handleMetaCallback(params: MetaCallbackParams): Promise<string> {
    const statePayload = await this.consumeMetaState(params.state);
    const targetOrigin =
      statePayload?.openerOrigin ?? this.getDefaultFrontendOrigin();

    if (params.error) {
      return this.renderMetaPopupMessage(targetOrigin, {
        type: 'META_OAUTH_ERROR',
        error: params.errorDescription || params.error,
      });
    }

    if (!params.code || !statePayload) {
      return this.renderMetaPopupMessage(targetOrigin, {
        type: 'META_OAUTH_ERROR',
        error: 'Missing or expired OAuth state',
      });
    }

    try {
      const tokenData = await this.exchangeMetaCode(params.code);
      const longLivedToken = await this.exchangeMetaLongLivedToken(
        tokenData.accessToken,
      );
      const accessToken = longLivedToken.accessToken || tokenData.accessToken;
      const userTokenExpiry = this.toExpiryIso(
        longLivedToken.expiresIn ?? tokenData.expiresIn,
      );
      const channels = await this.fetchMetaChannels(
        statePayload.type,
        accessToken,
        userTokenExpiry,
      );
      const resultId = ulid();
      const resultPayload: MetaOAuthResultPayload = {
        ...statePayload,
        channels,
        createdAt: new Date().toISOString(),
      };

      await this.redisService
        .getClient()
        .set(
          `${META_RESULT_PREFIX}${resultId}`,
          JSON.stringify(resultPayload),
          'EX',
          META_TTL_SECONDS,
        );

      return this.renderMetaPopupMessage(targetOrigin, {
        type: 'META_OAUTH_SUCCESS',
        provider: 'meta',
        resultId,
      });
    } catch (error: any) {
      this.logger.error(
        'Meta OAuth callback failed',
        error?.response?.data || error?.message || error,
      );
      return this.renderMetaPopupMessage(targetOrigin, {
        type: 'META_OAUTH_ERROR',
        error: 'Failed to complete Meta authorization',
      });
    }
  }

  async getMetaOAuthResult(
    resultId: string,
  ): Promise<{ channels: PublicMetaAvailableChannel[] }> {
    const payload = await this.getMetaResultPayload(resultId);

    return {
      channels: payload.channels.map((ch) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { accessToken, ...publicChannel } = ch;
        return publicChannel;
      }),
    };
  }

  async connectMetaChannels(
    dto: ConnectMetaChannelsDto,
  ): Promise<{ channels: Channel[] }> {
    if (!dto.selectedAccountIds.length) {
      throw new BadRequestException('At least one channel must be selected');
    }

    const payload = await this.getMetaResultPayload(dto.resultId);
    const selected = payload.channels.filter((channel) =>
      dto.selectedAccountIds.includes(channel.accountId),
    );

    if (selected.length === 0) {
      throw new BadRequestException('Selected channels were not found');
    }

    const connected: Channel[] = [];
    for (const channel of selected) {
      connected.push(await this.connectMetaChannel(channel));
    }

    await this.redisService
      .getClient()
      .del(`${META_RESULT_PREFIX}${dto.resultId}`);

    return { channels: connected };
  }

  async create(dto: CreateChannelDto): Promise<Channel> {
    const tenantId = this.cls.get('tenantId');
    await this.assertChannelAccountAvailable(dto.type, dto.account, tenantId);

    // --- Upsert: nếu channel (tenant+type+account) đã tồn tại thì update, không tạo mới ---
    const { channel } = await this.repository.upsert(
      tenantId,
      dto.type,
      dto.account,
      {
        ...dto,
        tenantId,
        status: 'Pending',
      },
    );

    if (
      (dto.type === 'Facebook' || dto.type === 'Instagram') &&
      dto.credentials?.accessToken
    ) {
      try {
        const userToken = dto.credentials.accessToken;

        // Fetch tất cả Facebook Pages của user (kèm IG business account nếu có)
        const pagesResponse = await axios.get(
          'https://graph.facebook.com/v19.0/me/accounts',
          {
            params: {
              access_token: userToken,
              fields:
                'id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}',
            },
          },
        );

        const pages: any[] = pagesResponse.data.data ?? [];

        let finalAccessToken = userToken;
        let finalPageName = dto.name;
        let avatarUrl = '';
        let webhookTargetId = dto.account; // ID dùng để subscribe webhook

        if (dto.type === 'Facebook') {
          // Match theo Facebook Page ID
          const matchedPage = pages.find((p) => p.id === dto.account);
          if (matchedPage) {
            finalAccessToken = matchedPage.access_token;
            finalPageName = matchedPage.name;
            avatarUrl = matchedPage.picture?.data?.url ?? '';
          }
          webhookTargetId = dto.account; // subscribe trực tiếp trên Page ID
        } else if (dto.type === 'Instagram') {
          // Tìm FB Page nào có instagram_business_account.id khớp với dto.account
          for (const page of pages) {
            const igAccount = page.instagram_business_account;
            if (igAccount && igAccount.id === dto.account) {
              finalAccessToken = page.access_token; // dùng Page Access Token
              finalPageName = igAccount.username ?? dto.name;
              avatarUrl = igAccount.profile_picture_url ?? '';
              webhookTargetId = page.id; // webhook subscribe trên FB Page, không phải IG ID
              break;
            }
          }
        }

        // Subscribe app webhooks
        await axios.post(
          `https://graph.facebook.com/v19.0/${webhookTargetId}/subscribed_apps`,
          {
            subscribed_fields: [
              'messages',
              'messaging_postbacks',
              'messaging_optins',
            ],
          },
          { params: { access_token: finalAccessToken } },
        );

        // Update channel với credentials, name và avatar thật
        await this.repository.update(tenantId, channel.id, {
          status: 'Connected',
          name: finalPageName,
          credentials: { ...dto.credentials, accessToken: finalAccessToken },
          config: { ...dto.config, avatarUrl },
        });

        channel.status = 'Connected';
        channel.name = finalPageName;
        channel.config = { ...dto.config, avatarUrl };
      } catch (error) {
        const err = error as any;
        console.error(
          'Failed to automated Meta channel setup:',
          err?.response?.data || err?.message,
        );
        await this.repository.update(tenantId, channel.id, { status: 'Error' });
        channel.status = 'Error';
      }
    }

    return channel;
  }

  async update(id: string, dto: UpdateChannelDto): Promise<Channel> {
    const tenantId = this.cls.get('tenantId');
    const channel = await this.repository.update(tenantId, id, dto);
    if (!channel) throw new NotFoundException('Channel not found');
    return channel;
  }

  async disconnect(id: string): Promise<Channel> {
    const tenantId = this.cls.get('tenantId');
    const channel = await this.repository.findByIdWithCredentials(tenantId, id);
    if (!channel) throw new NotFoundException('Channel not found');

    if (
      (channel.type === 'Facebook' || channel.type === 'Instagram') &&
      channel.credentials?.accessToken
    ) {
      try {
        await axios.delete(
          `https://graph.facebook.com/v19.0/${channel.account}/subscribed_apps`,
          {
            params: { access_token: channel.credentials.accessToken },
          },
        );
      } catch (error) {
        console.error(
          'Failed to unsubscribe Meta webhook during disconnect:',
          error instanceof Error
            ? error.message
            : (error as { response?: { data?: unknown } })?.response?.data ||
                'Unknown error',
        );
      }
    }

    const updated = await this.repository.update(tenantId, id, {
      status: 'Disconnected',
    });
    return updated!;
  }

  async delete(id: string): Promise<void> {
    const tenantId = this.cls.get('tenantId');
    const channel = await this.repository.findByIdWithCredentials(tenantId, id);
    if (!channel) throw new NotFoundException('Channel not found');

    // Attempt to disconnect first if it was connected
    if (channel.status === 'Connected') {
      await this.disconnect(id).catch(() => {});
    }

    const deleted = await this.repository.delete(tenantId, id);
    if (!deleted) throw new NotFoundException('Channel not found');
  }

  private async connectMetaChannel(
    metaChannel: MetaAvailableChannel,
  ): Promise<Channel> {
    const tenantId = this.cls.get('tenantId');
    await this.assertChannelAccountAvailable(
      metaChannel.type,
      metaChannel.accountId,
      tenantId,
    );

    const { channel } = await this.repository.upsert(
      tenantId,
      metaChannel.type,
      metaChannel.accountId,
      {
        tenantId,
        type: metaChannel.type,
        name: metaChannel.name,
        account: metaChannel.accountId,
        status: 'Pending',
        credentials: { accessToken: metaChannel.accessToken },
        config: {
          businessHoursOverride: false,
          autoReplyMessage: '',
          defaultRoutingRuleId: '',
          webhookStatus: 'Pending',
          tokenExpiry: metaChannel.tokenExpiry || '',
          avatarUrl: metaChannel.avatarUrl || '',
        },
      },
    );

    try {
      if (metaChannel.type === 'Facebook' || metaChannel.type === 'Instagram') {
        await axios.post(
          `https://graph.facebook.com/v19.0/${
            metaChannel.pageId || metaChannel.accountId
          }/subscribed_apps`,
          {
            subscribed_fields: [
              'messages',
              'messaging_postbacks',
              'messaging_optins',
            ],
          },
          { params: { access_token: metaChannel.accessToken } },
        );
      }

      const updated = await this.repository.update(tenantId, channel.id, {
        status: 'Connected',
        credentials: { accessToken: metaChannel.accessToken },
        config: {
          ...channel.config,
          webhookStatus: 'Active',
          tokenExpiry: metaChannel.tokenExpiry || '',
          avatarUrl: metaChannel.avatarUrl || '',
        },
      });

      return updated ?? channel;
    } catch (error: any) {
      this.logger.error(
        'Failed to connect Meta channel',
        error?.response?.data || error?.message || error,
      );
      const updated = await this.repository.update(tenantId, channel.id, {
        status: 'Error',
        config: {
          ...channel.config,
          webhookStatus: 'Error',
          tokenExpiry: metaChannel.tokenExpiry || '',
          avatarUrl: metaChannel.avatarUrl || '',
        },
      });
      return updated ?? { ...channel, status: 'Error' };
    }
  }

  private async assertChannelAccountAvailable(
    type: string,
    account: string,
    tenantId: string,
  ): Promise<void> {
    const existing = await this.repository.findAnyByAccount(type, account);
    if (!existing || existing.tenantId?.toString() === tenantId?.toString()) {
      return;
    }

    throw new ConflictException({
      message:
        `${type} channel "${account}" is already connected to another tenant. ` +
        'Disconnect it from the existing tenant before connecting it here.',
      errorCode: 'CHANNEL_ALREADY_CONNECTED_TO_ANOTHER_TENANT',
      errors: {
        type,
        account,
        existingTenantId: existing.tenantId,
      },
    });
  }

  private async getMetaResultPayload(
    resultId: string,
  ): Promise<MetaOAuthResultPayload> {
    const raw = await this.redisService
      .getClient()
      .get(`${META_RESULT_PREFIX}${resultId}`);
    if (!raw) {
      throw new NotFoundException('Meta OAuth result not found or expired');
    }

    const payload = JSON.parse(raw) as MetaOAuthResultPayload;
    const tenantId = this.cls.get('tenantId');
    const userId = this.cls.get('userId');

    if (
      payload.tenantId !== tenantId ||
      (payload.userId && payload.userId !== userId)
    ) {
      throw new NotFoundException('Meta OAuth result not found or expired');
    }

    return payload;
  }

  private async consumeMetaState(
    state?: string,
  ): Promise<MetaOAuthStatePayload | null> {
    if (!state) return null;

    const key = `${META_STATE_PREFIX}${state}`;
    const raw = await this.redisService.getClient().get(key);
    if (!raw) return null;

    await this.redisService.getClient().del(key);
    return JSON.parse(raw) as MetaOAuthStatePayload;
  }

  private async exchangeMetaCode(
    code: string,
  ): Promise<{ accessToken: string; expiresIn?: number }> {
    const response = await axios.get(
      'https://graph.facebook.com/v19.0/oauth/access_token',
      {
        params: {
          client_id: this.getMetaAppId(),
          client_secret: this.getMetaAppSecret(),
          redirect_uri: this.getMetaRedirectUri(),
          code,
        },
      },
    );

    if (!response.data?.access_token) {
      throw new BadRequestException('Meta token exchange failed');
    }

    return {
      accessToken: response.data.access_token,
      expiresIn: response.data.expires_in,
    };
  }

  private async exchangeMetaLongLivedToken(
    accessToken: string,
  ): Promise<{ accessToken?: string; expiresIn?: number }> {
    const response = await axios.get(
      'https://graph.facebook.com/v19.0/oauth/access_token',
      {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: this.getMetaAppId(),
          client_secret: this.getMetaAppSecret(),
          fb_exchange_token: accessToken,
        },
      },
    );

    return {
      accessToken: response.data?.access_token,
      expiresIn: response.data?.expires_in,
    };
  }

  private async fetchMetaChannels(
    type: MetaConnectionType,
    accessToken: string,
    userTokenExpiry: string | null,
  ): Promise<MetaAvailableChannel[]> {
    if (type === 'wa') {
      return this.fetchWhatsAppChannels(accessToken, userTokenExpiry);
    }

    const response = await axios.get(
      'https://graph.facebook.com/v19.0/me/accounts',
      {
        params: {
          access_token: accessToken,
          fields:
            'id,name,category,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}',
        },
      },
    );

    const pages: any[] = response.data?.data ?? [];
    const channels: MetaAvailableChannel[] = [];

    for (const page of pages) {
      if ((type === 'fb' || type === 'fb_ig') && page.access_token) {
        channels.push({
          accountId: page.id,
          pageId: page.id,
          name: page.name,
          category: page.category || 'Facebook Page',
          type: 'Facebook',
          accessToken: page.access_token,
          tokenExpiry: '',
          avatarUrl: page.picture?.data?.url ?? '',
        });
      }

      const igAccount = page.instagram_business_account;
      if (
        (type === 'ig' || type === 'fb_ig') &&
        igAccount?.id &&
        page.access_token
      ) {
        channels.push({
          accountId: igAccount.id,
          pageId: page.id,
          name: igAccount.username || `${page.name} (IG)`,
          category: 'Instagram Business',
          type: 'Instagram',
          accessToken: page.access_token,
          tokenExpiry: '',
          avatarUrl: igAccount.profile_picture_url ?? '',
        });
      }
    }

    return channels;
  }

  private async fetchWhatsAppChannels(
    accessToken: string,
    userTokenExpiry: string | null,
  ): Promise<MetaAvailableChannel[]> {
    const response = await axios.get(
      'https://graph.facebook.com/v19.0/me/businesses',
      {
        params: {
          access_token: accessToken,
          fields:
            'id,name,owned_whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number}}',
        },
      },
    );

    const businesses: any[] = response.data?.data ?? [];
    const channels: MetaAvailableChannel[] = [];

    for (const business of businesses) {
      const wabas = business.owned_whatsapp_business_accounts?.data ?? [];
      for (const waba of wabas) {
        const phones = waba.phone_numbers?.data ?? [];
        for (const phone of phones) {
          channels.push({
            accountId: phone.id,
            name: `${phone.display_phone_number} (${waba.name})`,
            category: 'WhatsApp Business',
            type: 'WhatsApp',
            accessToken,
            tokenExpiry: userTokenExpiry,
          });
        }
      }
    }

    return channels;
  }

  private normalizeMetaType(type: MetaConnectionType): MetaConnectionType {
    return ['fb', 'ig', 'wa', 'fb_ig'].includes(type) ? type : 'fb_ig';
  }

  private getMetaScopes(type: MetaConnectionType): string {
    if (type === 'fb') {
      return 'pages_show_list,pages_messaging,pages_read_engagement,pages_manage_metadata';
    }
    if (type === 'ig') {
      return 'instagram_basic,instagram_manage_messages,pages_show_list,pages_manage_metadata';
    }
    if (type === 'wa') {
      return 'business_management,whatsapp_business_management';
    }

    return 'pages_show_list,pages_messaging,pages_read_engagement,pages_manage_metadata,instagram_basic,instagram_manage_messages';
  }

  private getWhatsAppConfigId(type: MetaConnectionType): string | undefined {
    if (type !== 'wa') return undefined;
    return (
      process.env.FACEBOOK_WHATSAPP_CONFIG_ID ||
      process.env.META_WHATSAPP_CONFIG_ID ||
      '1328567121984336'
    );
  }

  private getMetaAppId(): string {
    const appId = process.env.FACEBOOK_APP_ID || process.env.META_APP_ID;
    if (!appId) throw new BadRequestException('Meta app ID is not configured');
    return appId;
  }

  private getMetaAppSecret(): string {
    const appSecret =
      process.env.FACEBOOK_APP_SECRET || process.env.META_APP_SECRET;
    if (!appSecret) {
      throw new BadRequestException('Meta app secret is not configured');
    }
    return appSecret;
  }

  private getMetaRedirectUri(): string {
    const backendDomain = this.configService.get('app.backendDomain', {
      infer: true,
    });
    const apiPrefix = this.configService.get('app.apiPrefix', { infer: true });
    return `${backendDomain}/${apiPrefix}/v1/channels/meta/callback`;
  }

  private toExpiryIso(expiresIn?: number): string | null {
    if (!expiresIn) return null;
    return new Date(Date.now() + expiresIn * 1000).toISOString();
  }

  private sanitizeFrontendOrigin(origin?: string): string {
    if (!origin) return this.getDefaultFrontendOrigin();

    try {
      const url = new URL(origin);
      const rootDomain = this.configService.get('app.rootDomain', {
        infer: true,
      });
      const isProd =
        this.configService.get('app.nodeEnv', { infer: true }) === 'production';
      const isLocalhost =
        !isProd &&
        (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
      const isAllowedDomain =
        url.hostname === rootDomain || url.hostname.endsWith(`.${rootDomain}`);

      if (
        (isLocalhost || isAllowedDomain) &&
        (!isProd || url.protocol === 'https:')
      ) {
        return url.origin;
      }
    } catch {
      // Fall through to configured frontend origin.
    }

    return this.getDefaultFrontendOrigin();
  }

  private getDefaultFrontendOrigin(): string {
    const frontendDomain = this.configService.get('app.frontendDomain', {
      infer: true,
    });
    const firstDomain = frontendDomain?.split(',')[0]?.trim();
    return firstDomain || 'http://localhost:4200';
  }

  private renderMetaPopupMessage(
    targetOrigin: string,
    payload: Record<string, unknown>,
  ): string {
    const serializedPayload = JSON.stringify(payload).replace(/</g, '\\u003c');
    const serializedOrigin = JSON.stringify(targetOrigin).replace(
      /</g,
      '\\u003c',
    );

    return `
      <!doctype html>
      <html>
        <body>
          <script>
            (function () {
              var payload = ${serializedPayload};
              var targetOrigin = ${serializedOrigin};
              if (window.opener) {
                window.opener.postMessage(payload, targetOrigin);
                window.close();
              }
            })();
          </script>
          <p>You can close this window.</p>
        </body>
      </html>
    `;
  }
}
