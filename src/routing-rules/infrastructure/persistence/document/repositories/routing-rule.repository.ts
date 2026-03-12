import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  RoutingRuleSchemaClass,
  RoutingRuleSchemaDocument,
} from '../entities/routing-rule.schema';
import { RoutingRule } from '../../../../domain/routing-rule';
import { RoutingRuleMapper } from '../mappers/routing-rule.mapper';

@Injectable()
export class RoutingRuleRepository {
  constructor(
    @InjectModel(RoutingRuleSchemaClass.name)
    private readonly model: Model<RoutingRuleSchemaDocument>,
  ) {}

  async findAll(tenant: string): Promise<RoutingRule[]> {
    const docs = await this.model.find({ tenant }).sort({ priority: 1 }).exec();
    return docs.map(RoutingRuleMapper.toDomain);
  }

  async findById(tenant: string, id: string): Promise<RoutingRule | null> {
    const doc = await this.model.findOne({ _id: id, tenant }).exec();
    return doc ? RoutingRuleMapper.toDomain(doc) : null;
  }

  async create(data: Partial<RoutingRule>): Promise<RoutingRule> {
    const doc = await this.model.create(data);
    return RoutingRuleMapper.toDomain(doc);
  }

  async update(
    tenant: string,
    id: string,
    data: Partial<RoutingRule>,
  ): Promise<RoutingRule | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenant }, { $set: data }, { new: true })
      .exec();
    return doc ? RoutingRuleMapper.toDomain(doc) : null;
  }

  async delete(tenant: string, id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, tenant }).exec();
    return result.deletedCount > 0;
  }

  async reorder(tenant: string, orderedIds: string[]): Promise<RoutingRule[]> {
    const bulkOps = orderedIds.map((id, index) => ({
      updateOne: {
        filter: { _id: id, tenant },
        update: { $set: { priority: index } },
      },
    }));
    await this.model.bulkWrite(bulkOps);
    return this.findAll(tenant);
  }
}
