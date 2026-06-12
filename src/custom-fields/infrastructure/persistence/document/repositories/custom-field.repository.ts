import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CustomFieldSchemaClass,
  CustomFieldSchemaDocument,
} from '../entities/custom-field.schema';
import { CustomField } from '../../../../domain/custom-field';
import { CustomFieldMapper } from '../mappers/custom-field.mapper';

@Injectable()
export class CustomFieldRepository {
  constructor(
    @InjectModel(CustomFieldSchemaClass.name)
    private readonly model: Model<CustomFieldSchemaDocument>,
  ) {}

  async findByTenant(tenantId: string): Promise<CustomField[]> {
    // Exclude soft-deleted fields (isActive === false). `$ne: false` keeps
    // legacy documents that predate the isActive flag (undefined → treated active).
    const docs = await this.model
      .find({ tenantId, isActive: { $ne: false } })
      .sort({ orderIndex: 1 })
      .exec();
    return docs.map(CustomFieldMapper.toDomain);
  }

  async findByModule(tenantId: string, module: string): Promise<CustomField[]> {
    const docs = await this.model
      .find({ tenantId, module, isActive: { $ne: false } })
      .sort({ orderIndex: 1 })
      .exec();
    return docs.map(CustomFieldMapper.toDomain);
  }

  async create(
    tenantId: string,
    data: Omit<CustomField, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>,
  ): Promise<CustomField> {
    const doc = await this.model.create({ tenantId, ...data });
    return CustomFieldMapper.toDomain(doc);
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<CustomField>,
  ): Promise<CustomField | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenantId }, data, { new: true })
      .exec();
    return doc ? CustomFieldMapper.toDomain(doc) : null;
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await this.model.deleteOne({ _id: id, tenantId }).exec();
  }
}
