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
    const channel = await this.repository.findByAccount(type, account);
    if (!channel) throw new NotFoundException('Channel not found');
    return channel;
  }

  async create(dto: CreateChannelDto): Promise<Channel> {
    const tenant = this.cls.get('tenantId');
    const channel = await this.repository.create({
      ...dto,
      tenant,
      status: 'Pending', // Initially pending
    });

    if ((dto.type === 'Facebook' || dto.type === 'Instagram') && dto.credentials?.accessToken) {
      try {
        await axios.post(
          `https://graph.facebook.com/v19.0/${dto.account}/subscribed_apps`,
          {
            subscribed_fields: ['messages', 'messaging_postbacks'],
          },
          {
            params: { access_token: dto.credentials.accessToken },
          }
        );
        // If success, update to Connected
        channel.status = 'Connected';
        await this.repository.update(tenant, channel.id, { status: 'Connected' });
      } catch (error) {
        console.error('Failed to subscribe Meta webhook:', error?.response?.data || error.message);
        // Stay as Pending or Error based on your logic
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

  async delete(id: string): Promise<void> {
    const tenant = this.cls.get('tenantId');
    const deleted = await this.repository.delete(tenant, id);
    if (!deleted) throw new NotFoundException('Channel not found');
  }
}
