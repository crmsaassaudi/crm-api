import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, SortOrder } from 'mongoose';
import {
  SocialPostTaskSchemaClass,
  SocialPostTaskSchemaDocument,
} from '../infrastructure/persistence/document/entities/social-post-task.schema';
import {
  SocialPostPlatform,
  SocialPostTaskStatus,
} from '../social-posts.types';

export interface SocialPostTaskEntity {
  id: string;
  tenantId: string;
  postId: string;
  channelId: string;
  channelName: string;
  channelAccount: string;
  platform: SocialPostPlatform;
  status: SocialPostTaskStatus;
  scheduledAt?: Date;
  publishedAt?: Date;
  platformPostId?: string;
  platformMediaId?: string;
  platformResponseRaw?: Record<string, any>;
  retryCount: number;
  maxRetries: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SocialPostTaskQuery {
  tenantId: string;
  status?: SocialPostTaskStatus;
  platform?: string;
}

@Injectable()
export class SocialPostTaskRepository {
  constructor(
    @InjectModel(SocialPostTaskSchemaClass.name)
    private readonly model: Model<SocialPostTaskSchemaDocument>,
  ) {}

  async createMany(
    data: Partial<SocialPostTaskSchemaClass>[],
  ): Promise<SocialPostTaskEntity[]> {
    if (data.length === 0) return [];
    const docs = await this.model.insertMany(data, { ordered: false });
    return docs.map((doc) => this.toEntity(doc));
  }

  async replaceForPost(
    tenantId: string,
    postId: string,
    data: Partial<SocialPostTaskSchemaClass>[],
  ): Promise<SocialPostTaskEntity[]> {
    await this.model.deleteMany({ tenantId, postId }).exec();
    return this.createMany(data);
  }

  async findById(
    tenantId: string,
    id: string,
  ): Promise<SocialPostTaskEntity | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? this.toEntity(doc) : null;
  }

  async findByPostId(
    tenantId: string,
    postId: string,
  ): Promise<SocialPostTaskEntity[]> {
    const docs = await this.model
      .find({ tenantId, postId })
      .sort({ createdAt: 1 })
      .exec();
    return docs.map((doc) => this.toEntity(doc));
  }

  async findPaginated(
    query: SocialPostTaskQuery,
    page: number,
    limit: number,
  ): Promise<{ items: SocialPostTaskEntity[]; total: number }> {
    const filter: FilterQuery<SocialPostTaskSchemaDocument> = {
      tenantId: query.tenantId,
    };
    if (query.status) filter.status = query.status;
    if (query.platform) filter.platform = query.platform;

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
    data: Partial<SocialPostTaskSchemaClass>,
  ): Promise<SocialPostTaskEntity | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true })
      .exec();
    return doc ? this.toEntity(doc) : null;
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: SocialPostTaskStatus,
    extra?: Partial<SocialPostTaskSchemaClass>,
  ): Promise<SocialPostTaskEntity | null> {
    return this.update(tenantId, id, { status, ...extra });
  }

  async incrementRetry(
    tenantId: string,
    id: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<SocialPostTaskEntity | null> {
    const doc = await this.model
      .findOneAndUpdate(
        { _id: id, tenantId },
        {
          $inc: { retryCount: 1 },
          $set: {
            status: 'FAILED',
            errorCode,
            errorMessage,
          },
        },
        { new: true },
      )
      .exec();
    return doc ? this.toEntity(doc) : null;
  }

  async resetForRetry(
    tenantId: string,
    id: string,
  ): Promise<SocialPostTaskEntity | null> {
    const doc = await this.model
      .findOneAndUpdate(
        { _id: id, tenantId },
        {
          $set: {
            status: 'PENDING',
            errorCode: undefined,
            errorMessage: undefined,
            platformPostId: undefined,
            platformMediaId: undefined,
            platformResponseRaw: undefined,
          },
        },
        { new: true },
      )
      .exec();
    return doc ? this.toEntity(doc) : null;
  }

  private toEntity(raw: any): SocialPostTaskEntity {
    const obj = typeof raw.toObject === 'function' ? raw.toObject() : raw;
    return {
      id: obj._id?.toString() ?? obj.id,
      tenantId: obj.tenantId?.toString(),
      postId: obj.postId?.toString(),
      channelId: obj.channelId?.toString(),
      channelName: obj.channelName,
      channelAccount: obj.channelAccount,
      platform: obj.platform,
      status: obj.status,
      scheduledAt: obj.scheduledAt,
      publishedAt: obj.publishedAt,
      platformPostId: obj.platformPostId,
      platformMediaId: obj.platformMediaId,
      platformResponseRaw: obj.platformResponseRaw,
      retryCount: obj.retryCount ?? 0,
      maxRetries: obj.maxRetries ?? 3,
      errorCode: obj.errorCode,
      errorMessage: obj.errorMessage,
      createdAt: obj.createdAt,
      updatedAt: obj.updatedAt,
    };
  }
}
