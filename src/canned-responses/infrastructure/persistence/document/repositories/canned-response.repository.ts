import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import {
  CannedResponseSchemaClass,
  CannedResponseSchemaDocument,
} from '../entities/canned-response.schema';
import { CannedResponse } from '../../../../domain/canned-response';
import { CannedResponseMapper } from '../mappers/canned-response.mapper';
import { escapeRegex } from '../../../../../utils/escape-regex';

@Injectable()
export class CannedResponseRepository {
  constructor(
    @InjectModel(CannedResponseSchemaClass.name)
    private readonly model: Model<CannedResponseSchemaDocument>,
  ) {}

  async findAll(
    tenantId: string,
    userId: string,
    query?: { scope?: string; category?: string; search?: string },
  ): Promise<CannedResponse[]> {
    const filter: FilterQuery<CannedResponseSchemaClass> = {
      tenantId,
      $or: [
        { scope: 'Public' },
        { scope: 'Private', createdById: userId },
        { scope: 'Team' },
      ],
    };
    if (query?.category) filter.category = query.category;
    if (query?.search) {
      // MED-07: Escape user input to prevent ReDoS
      filter.shortcut = { $regex: escapeRegex(query.search), $options: 'i' };
    }
    const docs = await this.model.find(filter).sort({ shortcut: 1 }).exec();
    return docs.map(CannedResponseMapper.toDomain);
  }

  async findById(tenantId: string, id: string): Promise<CannedResponse | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? CannedResponseMapper.toDomain(doc) : null;
  }

  async create(data: Partial<CannedResponse>): Promise<CannedResponse> {
    const doc = await this.model.create(data);
    return CannedResponseMapper.toDomain(doc);
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<CannedResponse>,
  ): Promise<CannedResponse | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true })
      .exec();
    return doc ? CannedResponseMapper.toDomain(doc) : null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, tenantId }).exec();
    return result.deletedCount > 0;
  }
}
