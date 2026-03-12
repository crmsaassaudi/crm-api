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
    const docs = await this.model.find({ tenant }).sort({ name: 1 }).exec();
    return docs.map(ChannelMapper.toDomain);
  }

  async findById(tenant: string, id: string): Promise<Channel | null> {
    const doc = await this.model.findOne({ _id: id, tenant }).exec();
    return doc ? ChannelMapper.toDomain(doc) : null;
  }

  async create(data: Partial<Channel>): Promise<Channel> {
    const doc = await this.model.create(data);
    return ChannelMapper.toDomain(doc);
  }

  async update(
    tenant: string,
    id: string,
    data: Partial<Channel>,
  ): Promise<Channel | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenant }, { $set: data }, { new: true })
      .exec();
    return doc ? ChannelMapper.toDomain(doc) : null;
  }

  async delete(tenant: string, id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, tenant }).exec();
    return result.deletedCount > 0;
  }
}
