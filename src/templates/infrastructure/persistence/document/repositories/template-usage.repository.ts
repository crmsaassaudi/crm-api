import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  TemplateUsageSchemaClass,
  TemplateUsageSchemaDocument,
} from '../entities/template-usage.schema';

@Injectable()
export class TemplateUsageRepository {
  constructor(
    @InjectModel(TemplateUsageSchemaClass.name)
    private readonly model: Model<TemplateUsageSchemaDocument>,
  ) {}

  async record(entry: {
    tenantId: string;
    templateId: string;
    variantId?: string;
    channel: string;
    context: string;
    contextId?: string;
    actorId?: string;
    count: number;
  }): Promise<void> {
    await this.model.create(entry);
  }
}
