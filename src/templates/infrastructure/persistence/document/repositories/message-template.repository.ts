import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { MessageTemplate } from '../../../../domain/message-template';
import { escapeRegex } from '../../../../../utils/escape-regex';
import {
  MessageTemplateSchemaClass,
  MessageTemplateSchemaDocument,
} from '../entities/message-template.schema';
import { MessageTemplateMapper } from '../mappers/message-template.mapper';

export interface MessageTemplateQuery {
  purpose?: string;
  tag?: string;
  search?: string;
}

@Injectable()
export class MessageTemplateRepository {
  constructor(
    @InjectModel(MessageTemplateSchemaClass.name)
    private readonly model: Model<MessageTemplateSchemaDocument>,
  ) {}

  async findAll(
    tenantId: string,
    userId: string,
    query?: MessageTemplateQuery,
  ): Promise<MessageTemplate[]> {
    const filter: FilterQuery<MessageTemplateSchemaClass> = {
      tenantId,
      deletedAt: null,
      $or: [
        { visibility: 'tenant' },
        { visibility: 'team' },
        { visibility: 'private', ownerId: userId },
      ],
    };
    if (query?.purpose) filter.purpose = query.purpose;
    if (query?.tag) filter.tags = query.tag;
    if (query?.search) {
      filter.name = { $regex: escapeRegex(query.search), $options: 'i' };
    }
    const docs = await this.model.find(filter).sort({ name: 1 }).exec();
    return docs.map(MessageTemplateMapper.toDomain);
  }

  async findById(
    tenantId: string,
    id: string,
  ): Promise<MessageTemplate | null> {
    const doc = await this.model
      .findOne({ _id: id, tenantId, deletedAt: null })
      .exec();
    return doc ? MessageTemplateMapper.toDomain(doc) : null;
  }

  async findByName(
    tenantId: string,
    name: string,
  ): Promise<MessageTemplate | null> {
    const doc = await this.model
      .findOne({ name, tenantId, deletedAt: null })
      .exec();
    return doc ? MessageTemplateMapper.toDomain(doc) : null;
  }

  async create(
    data: Partial<MessageTemplate>,
  ): Promise<MessageTemplate> {
    const doc = await this.model.create(
      MessageTemplateMapper.toPersistence(data),
    );
    return MessageTemplateMapper.toDomain(doc);
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<MessageTemplate>,
  ): Promise<MessageTemplate | null> {
    const doc = await this.model
      .findOneAndUpdate(
        { _id: id, tenantId, deletedAt: null },
        { $set: MessageTemplateMapper.toPersistence(data) },
        { new: true },
      )
      .exec();
    return doc ? MessageTemplateMapper.toDomain(doc) : null;
  }

  async softDelete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.model
      .updateOne(
        { _id: id, tenantId, deletedAt: null },
        { $set: { deletedAt: new Date() } },
      )
      .exec();
    return result.modifiedCount > 0;
  }

  async recordUsage(
    tenantId: string,
    id: string,
    incrementBy: number,
    at: Date,
  ): Promise<void> {
    await this.model
      .updateOne(
        { _id: id, tenantId },
        { $inc: { usageCount: incrementBy }, $set: { lastUsedAt: at } },
      )
      .exec();
  }
}
