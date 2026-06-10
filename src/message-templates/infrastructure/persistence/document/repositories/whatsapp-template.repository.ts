import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  WhatsAppTemplateSchemaClass,
  WhatsAppTemplateSchemaDocument,
} from '../entities/whatsapp-template.schema';
import { WhatsAppTemplate } from '../../../../domain/whatsapp-template';
import { WhatsAppTemplateMapper } from '../mappers/whatsapp-template.mapper';

@Injectable()
export class WhatsAppTemplateRepository {
  constructor(
    @InjectModel(WhatsAppTemplateSchemaClass.name)
    private readonly model: Model<WhatsAppTemplateSchemaDocument>,
  ) {}

  async findAll(tenantId: string): Promise<WhatsAppTemplate[]> {
    const docs = await this.model
      .find({ tenantId })
      .sort({ createdAt: -1 })
      .exec();
    return docs.map(WhatsAppTemplateMapper.toDomain);
  }

  async findById(
    tenantId: string,
    id: string,
  ): Promise<WhatsAppTemplate | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? WhatsAppTemplateMapper.toDomain(doc) : null;
  }

  async findByName(
    tenantId: string,
    name: string,
  ): Promise<WhatsAppTemplate | null> {
    const doc = await this.model.findOne({ name, tenantId }).exec();
    return doc ? WhatsAppTemplateMapper.toDomain(doc) : null;
  }

  async create(data: Partial<WhatsAppTemplate>): Promise<WhatsAppTemplate> {
    const doc = await this.model.create(data);
    return WhatsAppTemplateMapper.toDomain(doc);
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<WhatsAppTemplate>,
  ): Promise<WhatsAppTemplate | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true })
      .exec();
    return doc ? WhatsAppTemplateMapper.toDomain(doc) : null;
  }

  async updateByName(
    tenantId: string,
    name: string,
    data: Partial<WhatsAppTemplate>,
  ): Promise<WhatsAppTemplate | null> {
    const doc = await this.model
      .findOneAndUpdate({ name, tenantId }, { $set: data }, { new: true })
      .exec();
    return doc ? WhatsAppTemplateMapper.toDomain(doc) : null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, tenantId }).exec();
    return result.deletedCount > 0;
  }
}
