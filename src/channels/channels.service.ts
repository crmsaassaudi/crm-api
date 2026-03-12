import { Injectable, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ChannelRepository } from './infrastructure/persistence/document/repositories/channel.repository';
import { Channel } from './domain/channel';
import { CreateChannelDto, UpdateChannelDto } from './dto/channel.dto';

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

  async create(dto: CreateChannelDto): Promise<Channel> {
    const tenant = this.cls.get('tenantId');
    return this.repository.create({
      ...dto,
      tenant,
      status: 'Pending',
    });
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
