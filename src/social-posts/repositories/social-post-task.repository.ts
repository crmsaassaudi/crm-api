import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, SortOrder } from 'mongoose';
import {
  PublicationInstanceSchemaClass,
  PublicationInstanceSchemaDocument,
} from '../infrastructure/persistence/document/entities/social-post-task.schema';
import {
  PublicationInstanceStatus,
  PublicationSnapshot,
  SocialContentPlatform,
} from '../social-posts.types';

export interface PublicationInstanceEntity {
  id: string;
  tenantId: string;
  assetId: string;
  sourceVersionId: string;
  publicationGroupId: string;
  channelId: string;
  channelName: string;
  channelAccount: string;
  platform: SocialContentPlatform;
  snapshot: PublicationSnapshot;
  status: PublicationInstanceStatus;
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

export interface PublicationInstanceQuery {
  tenantId: string;
  assetId?: string;
  status?: PublicationInstanceStatus;
  platform?: string;
  from?: Date;
  to?: Date;
}

@Injectable()
export class PublicationInstanceRepository {
  constructor(
    @InjectModel(PublicationInstanceSchemaClass.name)
    private readonly model: Model<PublicationInstanceSchemaDocument>,
  ) {}

  async createMany(
    data: Partial<PublicationInstanceSchemaClass>[],
  ): Promise<PublicationInstanceEntity[]> {
    if (data.length === 0) return [];
    const docs = await this.model.insertMany(data, { ordered: false });
    return docs.map((doc) => this.toEntity(doc));
  }

  async findById(
    tenantId: string,
    id: string,
  ): Promise<PublicationInstanceEntity | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? this.toEntity(doc) : null;
  }

  async findByAssetId(
    tenantId: string,
    assetId: string,
  ): Promise<PublicationInstanceEntity[]> {
    const docs = await this.model
      .find({ tenantId, assetId })
      .sort({ updatedAt: -1 })
      .exec();
    return docs.map((doc) => this.toEntity(doc));
  }

  async findPaginated(
    query: PublicationInstanceQuery,
    page: number,
    limit: number,
  ): Promise<{ items: PublicationInstanceEntity[]; total: number }> {
    const filter: FilterQuery<PublicationInstanceSchemaDocument> = {
      tenantId: query.tenantId,
    };
    if (query.assetId) filter.assetId = query.assetId;
    if (query.status) filter.status = query.status;
    if (query.platform) filter.platform = query.platform;
    if (query.from || query.to) {
      filter.scheduledAt = {};
      if (query.from) filter.scheduledAt.$gte = query.from;
      if (query.to) filter.scheduledAt.$lte = query.to;
    }

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
    data: Partial<PublicationInstanceSchemaClass>,
  ): Promise<PublicationInstanceEntity | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true })
      .exec();
    return doc ? this.toEntity(doc) : null;
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: PublicationInstanceStatus,
    extra?: Partial<PublicationInstanceSchemaClass>,
  ): Promise<PublicationInstanceEntity | null> {
    return this.update(tenantId, id, { status, ...extra });
  }

  async incrementRetry(
    tenantId: string,
    id: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<PublicationInstanceEntity | null> {
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
  ): Promise<PublicationInstanceEntity | null> {
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

  private toEntity(raw: any): PublicationInstanceEntity {
    const obj = typeof raw.toObject === 'function' ? raw.toObject() : raw;
    return {
      id: obj._id?.toString() ?? obj.id,
      tenantId: obj.tenantId?.toString(),
      assetId: obj.assetId?.toString(),
      sourceVersionId: obj.sourceVersionId?.toString(),
      publicationGroupId: obj.publicationGroupId,
      channelId: obj.channelId?.toString(),
      channelName: obj.channelName,
      channelAccount: obj.channelAccount,
      platform: obj.platform,
      snapshot: {
        content: obj.snapshot?.content ?? '',
        mediaUrls: obj.snapshot?.mediaUrls ?? [],
        aiVideoJobIds: obj.snapshot?.aiVideoJobIds ?? [],
        mediaType: obj.snapshot?.mediaType ?? 'text',
      },
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
