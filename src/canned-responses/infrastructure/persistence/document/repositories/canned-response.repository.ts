import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import {
  CannedResponseSchemaClass,
  CannedResponseSchemaDocument,
} from '../entities/canned-response.schema';
import { CannedResponse } from '../../../../domain/canned-response';
import { CannedResponseMapper } from '../mappers/canned-response.mapper';

@Injectable()
export class CannedResponseRepository {
  constructor(
    @InjectModel(CannedResponseSchemaClass.name)
    private readonly model: Model<CannedResponseSchemaDocument>,
  ) {}

  async findAll(
    tenant: string,
    userId: string,
    query?: { scope?: string; category?: string; search?: string },
  ): Promise<CannedResponse[]> {
    const filter: FilterQuery<CannedResponseSchemaClass> = {
      tenant,
      $or: [
        { scope: 'Public' },
        { scope: 'Private', createdBy: userId },
        { scope: 'Team' },
      ],
    };
    if (query?.category) filter.category = query.category;
    if (query?.search) {
      filter.shortcut = { $regex: query.search, $options: 'i' };
    }
    const docs = await this.model.find(filter).sort({ shortcut: 1 }).exec();
    return docs.map(CannedResponseMapper.toDomain);
  }

  async findById(tenant: string, id: string): Promise<CannedResponse | null> {
    const doc = await this.model.findOne({ _id: id, tenant }).exec();
    return doc ? CannedResponseMapper.toDomain(doc) : null;
  }

  async create(data: Partial<CannedResponse>): Promise<CannedResponse> {
    const doc = await this.model.create(data);
    return CannedResponseMapper.toDomain(doc);
  }

  async update(
    tenant: string,
    id: string,
    data: Partial<CannedResponse>,
  ): Promise<CannedResponse | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenant }, { $set: data }, { new: true })
      .exec();
    return doc ? CannedResponseMapper.toDomain(doc) : null;
  }

  async delete(tenant: string, id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, tenant }).exec();
    return result.deletedCount > 0;
  }
}
