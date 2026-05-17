import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AutomationRuleSchemaClass,
  AutomationRuleSchemaDocument,
} from '../entities/automation-rule.schema';
import { AutomationRule } from '../../../../domain/automation-rule';
import { AutomationRuleMapper } from '../mappers/automation-rule.mapper';

@Injectable()
export class AutomationRuleRepository {
  constructor(
    @InjectModel(AutomationRuleSchemaClass.name)
    private readonly model: Model<AutomationRuleSchemaDocument>,
  ) {}

  async findAll(tenantId: string): Promise<AutomationRule[]> {
    const docs = await this.model.find({ tenantId }).sort({ name: 1 }).exec();
    return docs.map(AutomationRuleMapper.toDomain);
  }

  async findById(tenantId: string, id: string): Promise<AutomationRule | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? AutomationRuleMapper.toDomain(doc) : null;
  }

  async create(data: Partial<AutomationRule>): Promise<AutomationRule> {
    const doc = await this.model.create(data);
    return AutomationRuleMapper.toDomain(doc);
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<AutomationRule>,
  ): Promise<AutomationRule | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true })
      .exec();
    return doc ? AutomationRuleMapper.toDomain(doc) : null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, tenantId }).exec();
    return result.deletedCount > 0;
  }
}
