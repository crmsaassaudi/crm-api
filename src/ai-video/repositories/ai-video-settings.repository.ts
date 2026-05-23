import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AiVideoSettingsSchemaClass,
  AiVideoSettingsSchemaDocument,
} from '../infrastructure/persistence/document/entities/ai-video-settings.schema';
import { AiVideoSettings } from '../domain/ai-video-settings';
import { AiVideoSettingsMapper } from '../infrastructure/persistence/document/mappers/ai-video-settings.mapper';

@Injectable()
export class AiVideoSettingsRepository {
  constructor(
    @InjectModel(AiVideoSettingsSchemaClass.name)
    private readonly model: Model<AiVideoSettingsSchemaDocument>,
  ) {}

  async findByTenantId(tenantId: string): Promise<AiVideoSettings | null> {
    const doc = await this.model.findOne({ tenantId }).exec();
    return doc ? AiVideoSettingsMapper.toDomain(doc) : null;
  }

  async create(
    data: Partial<AiVideoSettingsSchemaClass>,
  ): Promise<AiVideoSettings> {
    const doc = await this.model.create(data);
    return AiVideoSettingsMapper.toDomain(doc);
  }

  async update(
    tenantId: string,
    data: Partial<AiVideoSettingsSchemaClass>,
  ): Promise<AiVideoSettings | null> {
    const doc = await this.model
      .findOneAndUpdate(
        { tenantId },
        { $set: data },
        { new: true, upsert: true },
      )
      .exec();
    return doc ? AiVideoSettingsMapper.toDomain(doc) : null;
  }
}
