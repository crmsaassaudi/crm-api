import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, SortOrder } from 'mongoose';
import {
  SocialPostSchemaClass,
  SocialPostSchemaDocument,
} from '../infrastructure/persistence/document/entities/social-post.schema';
import { SocialPostApprovalStatus, SocialPostStatus } from '../social-posts.types';

export interface SocialPostEntity {
  id: string;
  tenantId: string;
  content: string;
  mediaUrls: string[];
  mediaType: string;
  status: SocialPostStatus;
  approvalStatus: SocialPostApprovalStatus;
  scheduledAt?: Date;
  publishedAt?: Date;
  errorSummary?: string;
  createdById?: string;
  approvedById?: string;
  approvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface SocialPostQuery {
  tenantId: string;
  status?: SocialPostStatus;
  approvalStatus?: SocialPostApprovalStatus;
  from?: Date;
  to?: Date;
}

@Injectable()
export class SocialPostRepository {
  constructor(
    @InjectModel(SocialPostSchemaClass.name)
    private readonly model: Model<SocialPostSchemaDocument>,
  ) {}

  async create(
    data: Partial<SocialPostSchemaClass>,
  ): Promise<SocialPostEntity> {
    const doc = await this.model.create(data);
    return this.toEntity(doc);
  }

  async findById(
    tenantId: string,
    id: string,
  ): Promise<SocialPostEntity | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? this.toEntity(doc) : null;
  }

  async findPaginated(
    query: SocialPostQuery,
    page: number,
    limit: number,
  ): Promise<{ items: SocialPostEntity[]; total: number }> {
    const filter = this.buildFilter(query);
    const safePage = Math.max(1, page);
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const skip = (safePage - 1) * safeLimit;
    const sort: Record<string, SortOrder> = { createdAt: -1 };

    const [docs, total] = await Promise.all([
      this.model.find(filter).sort(sort).skip(skip).limit(safeLimit).exec(),
      this.model.countDocuments(filter).exec(),
    ]);

    return { items: docs.map((doc) => this.toEntity(doc)), total };
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<SocialPostSchemaClass>,
  ): Promise<SocialPostEntity | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true })
      .exec();
    return doc ? this.toEntity(doc) : null;
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: SocialPostStatus,
    extra?: Partial<SocialPostSchemaClass>,
  ): Promise<SocialPostEntity | null> {
    return this.update(tenantId, id, { status, ...extra });
  }

  private buildFilter(
    query: SocialPostQuery,
  ): FilterQuery<SocialPostSchemaDocument> {
    const filter: FilterQuery<SocialPostSchemaDocument> = {
      tenantId: query.tenantId,
    };
    if (query.status) filter.status = query.status;
    if (query.approvalStatus) filter.approvalStatus = query.approvalStatus;
    if (query.from || query.to) {
      filter.scheduledAt = {};
      if (query.from) filter.scheduledAt.$gte = query.from;
      if (query.to) filter.scheduledAt.$lte = query.to;
    }
    return filter;
  }

  private toEntity(raw: any): SocialPostEntity {
    const obj = typeof raw.toObject === 'function' ? raw.toObject() : raw;
    return {
      id: obj._id?.toString() ?? obj.id,
      tenantId: obj.tenantId?.toString(),
      content: obj.content ?? '',
      mediaUrls: obj.mediaUrls ?? [],
      mediaType: obj.mediaType ?? 'text',
      status: obj.status,
      approvalStatus: obj.approvalStatus,
      scheduledAt: obj.scheduledAt,
      publishedAt: obj.publishedAt,
      errorSummary: obj.errorSummary,
      createdById: obj.createdById?.toString(),
      approvedById: obj.approvedById?.toString(),
      approvedAt: obj.approvedAt,
      createdAt: obj.createdAt,
      updatedAt: obj.updatedAt,
    };
  }
}
