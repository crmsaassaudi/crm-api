import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  SMSTemplateSchemaClass,
  SMSTemplateSchemaDocument,
} from '../entities/sms-template.schema';
import { SMSTemplate } from '../../../../domain/sms-template';
import { SMSTemplateMapper } from '../mappers/sms-template.mapper';

@Injectable()
export class SMSTemplateRepository {
  constructor(
    @InjectModel(SMSTemplateSchemaClass.name)
    private readonly model: Model<SMSTemplateSchemaDocument>,
  ) {}

  async findAll(tenantId: string): Promise<SMSTemplate[]> {
    const docs = await this.model
      .find({ tenantId })
      .sort({ createdAt: -1 })
      .exec();
    return docs.map(SMSTemplateMapper.toDomain);
  }

  async findById(tenantId: string, id: string): Promise<SMSTemplate | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? SMSTemplateMapper.toDomain(doc) : null;
  }

  async create(data: Partial<SMSTemplate>): Promise<SMSTemplate> {
    const doc = await this.model.create(data);
    return SMSTemplateMapper.toDomain(doc);
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<SMSTemplate>,
  ): Promise<SMSTemplate | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true })
      .exec();
    return doc ? SMSTemplateMapper.toDomain(doc) : null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, tenantId }).exec();
    return result.deletedCount > 0;
  }
}
