import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  SocialPostVersionSchemaClass,
  SocialPostVersionSchemaDocument,
} from '../infrastructure/persistence/document/entities/social-post-version.schema';

export interface SocialPostVersionEntity {
  id: string;
  tenantId: string;
  postId: string;
  versionNumber: number;
  content: string;
  mediaUrls: string[];
  mediaType: string;
  savedById?: string;
  changeNote?: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class SocialPostVersionRepository {
  constructor(
    @InjectModel(SocialPostVersionSchemaClass.name)
    private readonly model: Model<SocialPostVersionSchemaDocument>,
  ) {}

  async create(
    data: Partial<SocialPostVersionSchemaClass>,
  ): Promise<SocialPostVersionEntity> {
    const doc = await this.model.create(data);
    return this.toEntity(doc);
  }

  async findById(
    tenantId: string,
    id: string,
  ): Promise<SocialPostVersionEntity | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? this.toEntity(doc) : null;
  }

  async findByPostId(
    tenantId: string,
    postId: string,
  ): Promise<SocialPostVersionEntity[]> {
    const docs = await this.model
      .find({ tenantId, postId })
      .sort({ versionNumber: -1 })
      .exec();
    return docs.map((doc) => this.toEntity(doc));
  }

  async findLatestByPostId(
    tenantId: string,
    postId: string,
  ): Promise<SocialPostVersionEntity | null> {
    const doc = await this.model
      .findOne({ tenantId, postId })
      .sort({ versionNumber: -1 })
      .exec();
    return doc ? this.toEntity(doc) : null;
  }

  async getNextVersionNumber(
    tenantId: string,
    postId: string,
  ): Promise<number> {
    const doc = await this.model
      .findOne({ tenantId, postId })
      .sort({ versionNumber: -1 })
      .select('versionNumber')
      .exec();
    return doc ? doc.versionNumber + 1 : 1;
  }

  private toEntity(raw: any): SocialPostVersionEntity {
    const obj = typeof raw.toObject === 'function' ? raw.toObject() : raw;
    return {
      id: obj._id?.toString() ?? obj.id,
      tenantId: obj.tenantId?.toString(),
      postId: obj.postId?.toString(),
      versionNumber: obj.versionNumber,
      content: obj.content ?? '',
      mediaUrls: obj.mediaUrls ?? [],
      mediaType: obj.mediaType ?? 'text',
      savedById: obj.savedById?.toString(),
      changeNote: obj.changeNote,
      createdAt: obj.createdAt,
      updatedAt: obj.updatedAt,
    };
  }
}
