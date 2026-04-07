import { Injectable, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ChannelRepository } from './infrastructure/persistence/document/repositories/channel.repository';
import { Channel } from './domain/channel';
import { CreateChannelDto, UpdateChannelDto } from './dto/channel.dto';
import axios from 'axios';

@Injectable()
export class ChannelsService {
  constructor(
    private readonly repository: ChannelRepository,
    private readonly cls: ClsService,
  ) {}

  async findAll(): Promise<Channel[]> {
    const tenant = this.cls.get('tenantId');
    return this.repository.findAll(tenant);
  }

  async findById(id: string): Promise<Channel> {
    const tenant = this.cls.get('tenantId');
    const channel = await this.repository.findById(tenant, id);
    if (!channel) throw new NotFoundException('Channel not found');
    return channel;
  }

  async findByAccount(type: string, account: string): Promise<Channel> {
    const tenant = this.cls.get('tenantId');
    const channel = await this.repository.findByAccount(tenant, type, account);
    if (!channel) throw new NotFoundException('Channel not found');
    return channel;
  }

  async findAnyByAccount(type: string, account: string): Promise<Channel> {
    const channel = await this.repository.findAnyByAccount(type, account);
    if (!channel) throw new NotFoundException('Channel not found');
    return channel;
  }

  async create(dto: CreateChannelDto): Promise<Channel> {
    const tenant = this.cls.get('tenantId');

    // --- Upsert: nếu channel (tenant+type+account) đã tồn tại thì update, không tạo mới ---
    const { channel } = await this.repository.upsert(
      tenant,
      dto.type,
      dto.account,
      {
        ...dto,
        tenantId: tenant,
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
        await this.repository.update(tenant, channel.id, {
          status: 'Connected',
          name: finalPageName,
          credentials: { ...dto.credentials, accessToken: finalAccessToken },
          config: { ...dto.config, avatarUrl },
        });

        channel.status = 'Connected';
        channel.name = finalPageName;
        channel.config = { ...dto.config, avatarUrl };
      } catch (error) {
        console.error(
          'Failed to automated Meta channel setup:',
          error?.response?.data || error.message,
        );
        await this.repository.update(tenant, channel.id, { status: 'Error' });
        channel.status = 'Error';
      }
    }

    return channel;
  }

  async update(id: string, dto: UpdateChannelDto): Promise<Channel> {
    const tenant = this.cls.get('tenantId');
    const channel = await this.repository.update(tenant, id, dto);
    if (!channel) throw new NotFoundException('Channel not found');
    return channel;
  }

  async disconnect(id: string): Promise<Channel> {
    const tenant = this.cls.get('tenantId');
    const channel = await this.repository.findByIdWithCredentials(tenant, id);
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
          error?.response?.data || error.message,
        );
      }
    }

    const updated = await this.repository.update(tenant, id, {
      status: 'Disconnected',
    });
    return updated!;
  }

  async delete(id: string): Promise<void> {
    const tenant = this.cls.get('tenantId');
    const channel = await this.repository.findByIdWithCredentials(tenant, id);
    if (!channel) throw new NotFoundException('Channel not found');

    // Attempt to disconnect first if it was connected
    if (channel.status === 'Connected') {
      await this.disconnect(id).catch(() => {});
    }

    const deleted = await this.repository.delete(tenant, id);
    if (!deleted) throw new NotFoundException('Channel not found');
  }
}
