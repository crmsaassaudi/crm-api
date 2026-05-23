import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  SocialContentAssetVersionSchemaClass,
  SocialContentAssetVersionSchemaDocument,
} from '../infrastructure/persistence/document/entities/social-post-version.schema';
import {
  SocialContentApprovalStatus,
  SocialContentMediaType,
} from '../social-posts.types';

export interface SocialContentAssetVersionEntity {
  id: string;
  tenantId: string;
  assetId: string;
  versionNumber: number;
  content: string;
  mediaUrls: string[];
  aiVideoJobIds: string[];
  mediaType: SocialContentMediaType;
  approvalStatus: SocialContentApprovalStatus;
  savedById?: string;
  approvedById?: string;
  approvedAt?: Date;
  rejectionReason?: string;
  changeNote?: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class SocialContentAssetVersionRepository {
  constructor(
    @InjectModel(SocialContentAssetVersionSchemaClass.name)
    private readonly model: Model<SocialContentAssetVersionSchemaDocument>,
  ) {}

  async create(
    data: Partial<SocialContentAssetVersionSchemaClass>,
  ): Promise<SocialContentAssetVersionEntity> {
    const doc = await this.model.create(data);
    return this.toEntity(doc);
  }

  async findById(
    tenantId: string,
    id: string,
  ): Promise<SocialContentAssetVersionEntity | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? this.toEntity(doc) : null;
  }

  async findByAssetId(
    tenantId: string,
    assetId: string,
  ): Promise<SocialContentAssetVersionEntity[]> {
    const docs = await this.model
      .find({ tenantId, assetId })
      .sort({ versionNumber: -1 })
      .exec();
    return docs.map((doc) => this.toEntity(doc));
  }

  async findLatestByAssetId(
    tenantId: string,
    assetId: string,
  ): Promise<SocialContentAssetVersionEntity | null> {
    const doc = await this.model
      .findOne({ tenantId, assetId })
      .sort({ versionNumber: -1 })
      .exec();
    return doc ? this.toEntity(doc) : null;
  }

  async getNextVersionNumber(
    tenantId: string,
    assetId: string,
  ): Promise<number> {
    const doc = await this.model
      .findOne({ tenantId, assetId })
      .sort({ versionNumber: -1 })
      .select('versionNumber')
      .exec();
    return doc ? doc.versionNumber + 1 : 1;
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<SocialContentAssetVersionSchemaClass>,
  ): Promise<SocialContentAssetVersionEntity | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true })
      .exec();
    return doc ? this.toEntity(doc) : null;
  }

  private toEntity(raw: any): SocialContentAssetVersionEntity {
    const obj = typeof raw.toObject === 'function' ? raw.toObject() : raw;
    return {
      id: obj._id?.toString() ?? obj.id,
      tenantId: obj.tenantId?.toString(),
      assetId: obj.assetId?.toString(),
      versionNumber: obj.versionNumber,
      content: obj.content ?? '',
      mediaUrls: obj.mediaUrls ?? [],
      aiVideoJobIds: obj.aiVideoJobIds ?? [],
      mediaType: obj.mediaType ?? 'text',
      approvalStatus: obj.approvalStatus,
      savedById: obj.savedById?.toString(),
      approvedById: obj.approvedById?.toString(),
      approvedAt: obj.approvedAt,
      rejectionReason: obj.rejectionReason,
      changeNote: obj.changeNote,
      createdAt: obj.createdAt,
      updatedAt: obj.updatedAt,
    };
  }
}
