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

  async findAll(tenantId: string): Promise<RoutingRule[]> {
    const docs = await this.model
      .find({ tenantId })
      .sort({ priority: 1 })
      .exec();
    return docs.map(RoutingRuleMapper.toDomain);
  }

  async findById(tenantId: string, id: string): Promise<RoutingRule | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? RoutingRuleMapper.toDomain(doc) : null;
  }

  async create(data: Partial<RoutingRule>): Promise<RoutingRule> {
    const doc = await this.model.create(data);
    return RoutingRuleMapper.toDomain(doc);
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<RoutingRule>,
  ): Promise<RoutingRule | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true })
      .exec();
    return doc ? RoutingRuleMapper.toDomain(doc) : null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, tenantId }).exec();
    return result.deletedCount > 0;
  }

  async findEnabledByTenant(tenantId: string): Promise<RoutingRule[]> {
    const docs = await this.model
      .find({ tenantId, enabled: true })
      .sort({ priority: 1 })
      .exec();
    return docs.map(RoutingRuleMapper.toDomain);
  }

  async reorder(
    tenantId: string,
    orderedIds: string[],
  ): Promise<RoutingRule[]> {
    const bulkOps = orderedIds.map((id, index) => ({
      updateOne: {
        filter: { _id: id, tenantId },
        update: { $set: { priority: index } },
      },
    }));
    await this.model.bulkWrite(bulkOps);
    return this.findAll(tenantId);
  }
}
