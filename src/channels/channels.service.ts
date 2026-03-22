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
    const channel = await this.repository.create({
      ...dto,
      tenant,
      status: 'Pending',
    });

    if ((dto.type === 'Facebook' || dto.type === 'Instagram') && dto.credentials?.accessToken) {
      try {
        const userToken = dto.credentials.accessToken;

        // 1. Fetch all pages managed by this user to get the specific Page Access Token and Page Name
        const pagesResponse = await axios.get('https://graph.facebook.com/v19.0/me/accounts', {
          params: { access_token: userToken, fields: 'id,name,access_token,picture{url}' },
        });

        const pages = pagesResponse.data.data ?? [];
        const matchedPage = pages.find((p: any) => p.id === dto.account);

        let finalAccessToken = userToken;
        let finalPageName = dto.name;
        let avatarUrl = '';

        if (matchedPage) {
          finalAccessToken = matchedPage.access_token;
          finalPageName = matchedPage.name;
          avatarUrl = matchedPage.picture?.data?.url;
        }

        // 2. Subscribe the app to webhooks for this page (requires Page Access Token)
        await axios.post(
          `https://graph.facebook.com/v19.0/${dto.account}/subscribed_apps`,
          { subscribed_fields: ['messages', 'messaging_postbacks', 'messaging_optins'] },
          { params: { access_token: finalAccessToken } },
        );

        // 3. Update Channel with real credentials, name and avatar
        await this.repository.update(tenant, channel.id, {
          status: 'Connected',
          name: finalPageName,
          credentials: { ...dto.credentials, accessToken: finalAccessToken },
          config: { ...dto.config, avatarUrl },
        });

        // Sync local object properties for the return value
        channel.status = 'Connected';
        channel.name = finalPageName;
        channel.config = { ...dto.config, avatarUrl };
      } catch (error) {
        console.error('Failed to automated Fanpage setup:', error?.response?.data || error.message);
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

    if ((channel.type === 'Facebook' || channel.type === 'Instagram') && channel.credentials?.accessToken) {
      try {
        await axios.delete(`https://graph.facebook.com/v19.0/${channel.account}/subscribed_apps`, {
          params: { access_token: channel.credentials.accessToken },
        });
      } catch (error) {
        console.error('Failed to unsubscribe Meta webhook during disconnect:', error?.response?.data || error.message);
      }
    }

    const updated = await this.repository.update(tenant, id, { status: 'Disconnected' });
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
