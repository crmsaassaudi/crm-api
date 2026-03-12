import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import { TagSchemaClass, TagSchemaDocument } from '../entities/tag.schema';
import { Tag } from '../../../../domain/tag';
import { TagMapper } from '../mappers/tag.mapper';

@Injectable()
export class TagRepository {
  constructor(
    @InjectModel(TagSchemaClass.name)
    private readonly model: Model<TagSchemaDocument>,
  ) {}

  async findAll(
    tenant: string,
    query?: { scope?: string; search?: string },
  ): Promise<Tag[]> {
    const filter: FilterQuery<TagSchemaClass> = { tenant };
    if (query?.scope) filter.scope = query.scope;
    if (query?.search) {
      filter.name = { $regex: query.search, $options: 'i' };
    }
    const docs = await this.model.find(filter).sort({ name: 1 }).exec();
    return docs.map(TagMapper.toDomain);
  }

  async findById(tenant: string, id: string): Promise<Tag | null> {
    const doc = await this.model.findOne({ _id: id, tenant }).exec();
    return doc ? TagMapper.toDomain(doc) : null;
  }

  async create(data: Partial<Tag>): Promise<Tag> {
    const doc = await this.model.create(data);
    return TagMapper.toDomain(doc);
  }

  async update(
    tenant: string,
    id: string,
    data: Partial<Tag>,
  ): Promise<Tag | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenant }, { $set: data }, { new: true })
      .exec();
    return doc ? TagMapper.toDomain(doc) : null;
  }

  async delete(tenant: string, id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, tenant }).exec();
    return result.deletedCount > 0;
  }
}
