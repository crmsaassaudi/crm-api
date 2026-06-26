import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import {
  RichMessageTemplateSchemaClass,
  RichMessageTemplateSchemaDocument,
} from '../entities/rich-message-template.schema';
import { RichMessageTemplate } from '../../../../domain/rich-message-template';
import { RichMessageTemplateMapper } from '../mappers/rich-message-template.mapper';
import { escapeRegex } from '../../../../../utils/escape-regex';

@Injectable()
export class RichMessageTemplateRepository {
  constructor(
    @InjectModel(RichMessageTemplateSchemaClass.name)
    private readonly model: Model<RichMessageTemplateSchemaDocument>,
  ) {}

  async findAll(
    tenantId: string,
    userId: string,
    query?: {
      type?: string;
      channelType?: string;
      scope?: string;
      search?: string;
      isActive?: boolean;
    },
  ): Promise<RichMessageTemplate[]> {
    const filter: FilterQuery<RichMessageTemplateSchemaClass> = {
      tenantId,
      $or: [{ scope: 'Public' }, { scope: 'Private', createdById: userId }],
    };
    if (query?.type) filter.type = query.type;
    if (query?.channelType) {
      filter.channelTypes = { $in: [query.channelType, 'all'] };
    }
    if (query?.isActive !== undefined) filter.isActive = query.isActive;
    if (query?.search) {
      filter.name = { $regex: escapeRegex(query.search), $options: 'i' };
    }
    const docs = await this.model.find(filter).sort({ name: 1 }).exec();
    return docs.map(RichMessageTemplateMapper.toDomain);
  }

  async findById(
    tenantId: string,
    id: string,
  ): Promise<RichMessageTemplate | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? RichMessageTemplateMapper.toDomain(doc) : null;
  }

  async create(
    data: Partial<RichMessageTemplate>,
  ): Promise<RichMessageTemplate> {
    // Build a plain persistence object via mapper (consistent with contact/task pattern)
    const persistence = RichMessageTemplateMapper.toPersistence(
      data as RichMessageTemplate,
    );
    const doc = await this.model.create(persistence);
    return RichMessageTemplateMapper.toDomain(doc);
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<RichMessageTemplate>,
  ): Promise<RichMessageTemplate | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true })
      .exec();
    return doc ? RichMessageTemplateMapper.toDomain(doc) : null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, tenantId }).exec();
    return result.deletedCount > 0;
  }
}
