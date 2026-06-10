import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  EmailTemplateSchemaClass,
  EmailTemplateSchemaDocument,
} from '../entities/email-template.schema';
import { EmailTemplate } from '../../../../domain/email-template';
import { EmailTemplateMapper } from '../mappers/email-template.mapper';

@Injectable()
export class EmailTemplateRepository {
  constructor(
    @InjectModel(EmailTemplateSchemaClass.name)
    private readonly model: Model<EmailTemplateSchemaDocument>,
  ) {}

  async findAll(tenantId: string): Promise<EmailTemplate[]> {
    const docs = await this.model
      .find({ tenantId })
      .sort({ createdAt: -1 })
      .exec();
    return docs.map(EmailTemplateMapper.toDomain);
  }

  async findById(tenantId: string, id: string): Promise<EmailTemplate | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? EmailTemplateMapper.toDomain(doc) : null;
  }

  async create(data: Partial<EmailTemplate>): Promise<EmailTemplate> {
    const doc = await this.model.create(data);
    return EmailTemplateMapper.toDomain(doc);
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<EmailTemplate>,
  ): Promise<EmailTemplate | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true })
      .exec();
    return doc ? EmailTemplateMapper.toDomain(doc) : null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, tenantId }).exec();
    return result.deletedCount > 0;
  }
}
