import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  SlaPolicySchemaClass,
  SlaPolicySchemaDocument,
} from '../entities/sla-policy.schema';
import { SlaPolicy } from '../../../../domain/sla-policy';
import { SlaPolicyMapper } from '../mappers/sla-policy.mapper';

@Injectable()
export class SlaPolicyRepository {
  constructor(
    @InjectModel(SlaPolicySchemaClass.name)
    private readonly model: Model<SlaPolicySchemaDocument>,
  ) {}

  async findAll(tenantId: string): Promise<SlaPolicy[]> {
    const docs = await this.model
      .find({ tenantId })
      .sort({ priority: 1 })
      .exec();
    return docs.map(SlaPolicyMapper.toDomain);
  }

  async findById(tenantId: string, id: string): Promise<SlaPolicy | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? SlaPolicyMapper.toDomain(doc) : null;
  }

  async create(data: Partial<SlaPolicy>): Promise<SlaPolicy> {
    const doc = await this.model.create(data);
    return SlaPolicyMapper.toDomain(doc);
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<SlaPolicy>,
  ): Promise<SlaPolicy | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true })
      .exec();
    return doc ? SlaPolicyMapper.toDomain(doc) : null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, tenantId }).exec();
    return result.deletedCount > 0;
  }
}
