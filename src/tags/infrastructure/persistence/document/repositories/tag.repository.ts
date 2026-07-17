import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import { TagSchemaClass, TagSchemaDocument } from '../entities/tag.schema';
import { Tag } from '../../../../domain/tag';
import { TagMapper } from '../mappers/tag.mapper';
import { escapeRegex } from '../../../../../utils/escape-regex';

@Injectable()
export class TagRepository {
  constructor(
    @InjectModel(TagSchemaClass.name)
    private readonly model: Model<TagSchemaDocument>,
  ) {}

  async findAll(
    tenantId: string,
    query?: { scope?: string; search?: string },
  ): Promise<Tag[]> {
    const filter: FilterQuery<TagSchemaClass> = { tenantId };
    if (query?.scope) filter.scope = query.scope;
    if (query?.search) {
      filter.name = { $regex: escapeRegex(query.search), $options: 'i' };
    }
    const docs = await this.model
      .find(filter)
      .sort({ scope: 1, order: 1, name: 1 })
      .exec();
    return docs.map(TagMapper.toDomain);
  }

  async findById(tenantId: string, id: string): Promise<Tag | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? TagMapper.toDomain(doc) : null;
  }

  async findByIds(
    tenantId: string,
    scope: string,
    ids: string[],
  ): Promise<Tag[]> {
    if (!ids.length) return [];
    const docs = await this.model
      .find({ tenantId, scope, _id: { $in: ids } })
      .exec();
    return docs.map(TagMapper.toDomain);
  }

  async findByExactName(
    tenantId: string,
    scope: string,
    name: string,
  ): Promise<Tag | null> {
    const doc = await this.model.findOne({ tenantId, scope, name }).exec();
    return doc ? TagMapper.toDomain(doc) : null;
  }

  async create(data: Partial<Tag>): Promise<Tag> {
    const doc = await this.model.create(data);
    return TagMapper.toDomain(doc);
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<Tag>,
  ): Promise<Tag | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true })
      .exec();
    return doc ? TagMapper.toDomain(doc) : null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, tenantId }).exec();
    return result.deletedCount > 0;
  }

  async reorder(
    tenantId: string,
    scope: string,
    orderedIds: string[],
  ): Promise<void> {
    if (!orderedIds.length) return;
    await this.model.bulkWrite(
      orderedIds.map((id, index) => ({
        updateOne: {
          filter: { _id: id, tenantId, scope },
          update: { $set: { order: index } },
        },
      })),
    );
  }
}
