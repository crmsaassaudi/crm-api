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

  async findByTenant(tenant: string): Promise<CustomField[]> {
    const docs = await this.model
      .find({ tenant })
      .sort({ orderIndex: 1 })
      .exec();
    return docs.map(CustomFieldMapper.toDomain);
  }

  async findByModule(tenant: string, module: string): Promise<CustomField[]> {
    const docs = await this.model
      .find({ tenant, module })
      .sort({ orderIndex: 1 })
      .exec();
    return docs.map(CustomFieldMapper.toDomain);
  }

  async create(
    tenant: string,
    data: Omit<CustomField, 'id' | 'tenant' | 'createdAt' | 'updatedAt'>,
  ): Promise<CustomField> {
    const doc = await this.model.create({ tenant, ...data });
    return CustomFieldMapper.toDomain(doc);
  }

  async update(
    tenant: string,
    id: string,
    data: Partial<CustomField>,
  ): Promise<CustomField | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenant }, data, { new: true })
      .exec();
    return doc ? CustomFieldMapper.toDomain(doc) : null;
  }

  async delete(tenant: string, id: string): Promise<void> {
    await this.model.deleteOne({ _id: id, tenant }).exec();
  }
}
