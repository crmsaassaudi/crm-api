import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ChannelSchemaClass,
  ChannelSchemaDocument,
} from '../entities/channel.schema';
import { Channel } from '../../../../domain/channel';
import { ChannelMapper } from '../mappers/channel.mapper';

@Injectable()
export class ChannelRepository {
  constructor(
    @InjectModel(ChannelSchemaClass.name)
    private readonly model: Model<ChannelSchemaDocument>,
  ) {}

  async findAll(tenant: string): Promise<Channel[]> {
    const docs = await this.model
      .find({ tenantId: tenant })
      .sort({ name: 1 })
      .exec();
    return docs.map(ChannelMapper.toDomain);
  }

  async findById(tenant: string, id: string): Promise<Channel | null> {
    const doc = await this.model.findOne({ _id: id, tenantId: tenant }).exec();
    return doc ? ChannelMapper.toDomain(doc) : null;
  }

  async findByAccount(
    tenant: string,
    type: string,
    account: string,
  ): Promise<Channel | null> {
    const doc = await this.model
      .findOne({ tenantId: tenant, type, account })
      .exec();
    return doc ? ChannelMapper.toDomain(doc) : null;
  }

  async findAnyByAccount(
    type: string,
    account: string,
  ): Promise<Channel | null> {
    const doc = await this.model
      .findOne({ type, account })
      .select('+credentials') // Include credentials so adapters can use the access token
      .exec();
    return doc ? ChannelMapper.toDomain(doc) : null;
  }

  async findByAccountWithCredentials(
    tenant: string,
    type: string,
    account: string,
  ): Promise<Channel | null> {
    const doc = await this.model
      .findOne({ tenantId: tenant, type, account, status: 'Connected' })
      .select('+credentials')
      .exec();
    return doc ? ChannelMapper.toDomain(doc) : null;
  }

  async findByIdWithCredentials(
    tenant: string,
    id: string,
  ): Promise<Channel | null> {
    const doc = await this.model
      .findOne({ _id: id, tenantId: tenant })
      .select('+credentials')
      .exec();
    return doc ? ChannelMapper.toDomain(doc) : null;
  }

  async create(data: Partial<Channel>): Promise<Channel> {
    const doc = await this.model.create(data);
    return ChannelMapper.toDomain(doc);
  }

  async upsert(
    tenant: string,
    type: string,
    account: string,
    data: Partial<Channel>,
  ): Promise<{ channel: Channel; isNew: boolean }> {
    const updateData = { ...data } as any;
    delete updateData.tenantId;
    const doc = await this.model
      .findOneAndUpdate(
        { tenantId: tenant, type, account },
        { $set: { ...updateData, tenantId: tenant, type, account } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      )
      .exec();
    // Mongoose doesn't expose isNew from findOneAndUpdate directly,
    // so we rely on updatedAt vs createdAt to detect new docs.
    const timeDiff = doc.updatedAt.getTime() - doc.createdAt.getTime();
    const isNew = timeDiff < 1000;
    return { channel: ChannelMapper.toDomain(doc), isNew };
  }

  async update(
    tenant: string,
    id: string,
    data: Partial<Channel>,
  ): Promise<Channel | null> {
    const doc = await this.model
      .findOneAndUpdate(
        { _id: id, tenantId: tenant },
        { $set: data },
        { new: true },
      )
      .exec();
    return doc ? ChannelMapper.toDomain(doc) : null;
  }

  async delete(tenant: string, id: string): Promise<boolean> {
    const result = await this.model
      .deleteOne({ _id: id, tenantId: tenant })
      .exec();
    return result.deletedCount > 0;
  }
}
