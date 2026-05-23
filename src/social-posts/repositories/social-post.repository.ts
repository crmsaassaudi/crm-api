import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, SortOrder } from 'mongoose';
import {
  SocialContentAssetSchemaClass,
  SocialContentAssetSchemaDocument,
} from '../infrastructure/persistence/document/entities/social-post.schema';
import { SocialContentAssetStatus } from '../social-posts.types';

export interface SocialContentAssetEntity {
  id: string;
  tenantId: string;
  title: string;
  status: SocialContentAssetStatus;
  createdById?: string;
  latestVersionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SocialContentAssetQuery {
  tenantId: string;
  status?: SocialContentAssetStatus;
}

@Injectable()
export class SocialContentAssetRepository {
  constructor(
    @InjectModel(SocialContentAssetSchemaClass.name)
    private readonly model: Model<SocialContentAssetSchemaDocument>,
  ) {}

  async create(
    data: Partial<SocialContentAssetSchemaClass>,
  ): Promise<SocialContentAssetEntity> {
    const doc = await this.model.create(data);
    return this.toEntity(doc);
  }

  async findById(
    tenantId: string,
    id: string,
  ): Promise<SocialContentAssetEntity | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? this.toEntity(doc) : null;
  }

  async findPaginated(
    query: SocialContentAssetQuery,
    page: number,
    limit: number,
  ): Promise<{ items: SocialContentAssetEntity[]; total: number }> {
    const filter = this.buildFilter(query);
    const safePage = Math.max(1, page);
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const skip = (safePage - 1) * safeLimit;
    const sort: Record<string, SortOrder> = { updatedAt: -1 };

    const [docs, total] = await Promise.all([
      this.model.find(filter).sort(sort).skip(skip).limit(safeLimit).exec(),
      this.model.countDocuments(filter).exec(),
    ]);

    return { items: docs.map((doc) => this.toEntity(doc)), total };
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<SocialContentAssetSchemaClass>,
  ): Promise<SocialContentAssetEntity | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true })
      .exec();
    return doc ? this.toEntity(doc) : null;
  }

  async archive(
    tenantId: string,
    id: string,
  ): Promise<SocialContentAssetEntity | null> {
    return this.update(tenantId, id, { status: 'ARCHIVED' });
  }

  private buildFilter(
    query: SocialContentAssetQuery,
  ): FilterQuery<SocialContentAssetSchemaDocument> {
    const filter: FilterQuery<SocialContentAssetSchemaDocument> = {
      tenantId: query.tenantId,
    };
    if (query.status) filter.status = query.status;
    return filter;
  }

  private toEntity(raw: any): SocialContentAssetEntity {
    const obj = typeof raw.toObject === 'function' ? raw.toObject() : raw;
    return {
      id: obj._id?.toString() ?? obj.id,
      tenantId: obj.tenantId?.toString(),
      title: obj.title ?? '',
      status: obj.status,
      createdById: obj.createdById?.toString(),
      latestVersionId: obj.latestVersionId?.toString(),
      createdAt: obj.createdAt,
      updatedAt: obj.updatedAt,
    };
  }
}
