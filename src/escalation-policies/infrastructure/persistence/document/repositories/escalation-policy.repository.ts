import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  EscalationPolicySchemaClass,
  EscalationPolicySchemaDocument,
} from '../entities/escalation-policy.schema';
import { EscalationPolicy } from '../../../../domain/escalation-policy';
import { EscalationPolicyMapper } from '../mappers/escalation-policy.mapper';

@Injectable()
export class EscalationPolicyRepository {
  constructor(
    @InjectModel(EscalationPolicySchemaClass.name)
    private readonly model: Model<EscalationPolicySchemaDocument>,
  ) {}

  async findAll(tenantId: string): Promise<EscalationPolicy[]> {
    const docs = await this.model.find({ tenantId }).sort({ name: 1 }).exec();
    return docs.map(EscalationPolicyMapper.toDomain);
  }

  async findById(
    tenantId: string,
    id: string,
  ): Promise<EscalationPolicy | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? EscalationPolicyMapper.toDomain(doc) : null;
  }

  async create(data: Partial<EscalationPolicy>): Promise<EscalationPolicy> {
    const doc = await this.model.create(data);
    return EscalationPolicyMapper.toDomain(doc);
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<EscalationPolicy>,
  ): Promise<EscalationPolicy | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true })
      .exec();
    return doc ? EscalationPolicyMapper.toDomain(doc) : null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, tenantId }).exec();
    return result.deletedCount > 0;
  }
}
