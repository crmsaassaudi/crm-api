import { Injectable } from '@nestjs/common';

import {
  FileRepository,
  PaginationOptions,
  PaginatedResult,
  FileListFilters,
} from '../../file.repository';
import { FileSchemaClass, FileSchemaDocument } from '../entities/file.schema';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import {
  FileType,
  FileAccessLevel,
  FileStatus,
} from '../../../../domain/file';

import { FileMapper } from '../mappers/file.mapper';
import { NullableType } from '../../../../../utils/types/nullable.type';

import { ClsService } from 'nestjs-cls';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

@Injectable()
export class FileDocumentRepository
  extends BaseDocumentRepository<FileSchemaDocument, FileType>
  implements FileRepository
{
  constructor(
    @InjectModel(FileSchemaClass.name)
    fileModel: Model<FileSchemaDocument>,
    cls: ClsService,
  ) {
    super(fileModel, cls);
  }

  protected mapToDomain(doc: FileSchemaClass): FileType {
    return FileMapper.toDomain(doc);
  }

  protected toPersistence(domain: FileType): FileSchemaClass {
    return FileMapper.toPersistence(domain);
  }

  /** Files are infrastructure objects — disable ownerId-based visibility filtering */
  protected enableDataVisibility(): boolean {
    return false;
  }

  async create(
    data: Omit<
      FileType,
      'id' | 'createdAt' | 'updatedAt' | 'version' | 'tenantId'
    >,
  ): Promise<FileType> {
    const domainEntity = new FileType();
    Object.assign(domainEntity, data);
    domainEntity.tenantId = this.cls.get('tenantId');

    const persistenceModel = FileMapper.toPersistence(domainEntity);
    const createdFile = new this.model(persistenceModel);
    const fileObject = await createdFile.save();
    return FileMapper.toDomain(fileObject);
  }

  async findById(id: FileType['id']): Promise<NullableType<FileType>> {
    const fileObject = await this.model.findById(id);
    return fileObject ? FileMapper.toDomain(fileObject) : null;
  }

  async findByIds(ids: FileType['id'][]): Promise<FileType[]> {
    const fileObjects = await this.model.find({ _id: { $in: ids } });
    return fileObjects.map((fileObject) => FileMapper.toDomain(fileObject));
  }

  // ── New implementations ────────────────────────────────────────

  async findByConversation(
    tenantId: string,
    conversationId: string,
    filters?: { mimeTypePrefix?: string },
    pagination?: PaginationOptions,
  ): Promise<PaginatedResult<FileType>> {
    const page = pagination?.page ?? DEFAULT_PAGE;
    const limit = pagination?.limit ?? DEFAULT_LIMIT;

    const query: FilterQuery<FileSchemaClass> = {
      tenantId,
      conversationId,
      isDeleted: { $ne: true },
      status: 'ready',
    };

    if (filters?.mimeTypePrefix) {
      query.mimeType = { $regex: `^${filters.mimeTypePrefix}` };
    }

    const [data, total] = await Promise.all([
      this.model
        .find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.model.countDocuments(query).exec(),
    ]);

    return {
      data: data.map((doc) => FileMapper.toDomain(doc as any)),
      total,
      page,
      limit,
    };
  }

  async findByTenant(
    tenantId: string,
    userId: string,
    userRole: string,
    filters?: FileListFilters,
    pagination?: PaginationOptions,
  ): Promise<PaginatedResult<FileType>> {
    const page = pagination?.page ?? DEFAULT_PAGE;
    const limit = pagination?.limit ?? DEFAULT_LIMIT;

    const query: FilterQuery<FileSchemaClass> = {
      tenantId,
      isDeleted: { $ne: true },
    };

    // ACL filtering: non-admin users can only see tenant/own/shared files
    const isAdmin = ['OWNER', 'ADMIN'].includes(userRole?.toUpperCase());
    if (!isAdmin) {
      query.$or = [
        { accessLevel: 'tenant' },
        { accessLevel: 'public' },
        { uploadedBy: userId },
        { allowedUserIds: userId },
      ];
    }

    if (filters?.category) query.category = filters.category;
    if (filters?.status) query.status = filters.status;
    if (filters?.uploadedBy) query.uploadedBy = filters.uploadedBy;
    if (filters?.mimeTypePrefix) {
      query.mimeType = { $regex: `^${filters.mimeTypePrefix}` };
    }
    if (filters?.search) {
      query.fileName = { $regex: filters.search, $options: 'i' };
    }
    if (filters?.folderId !== undefined) {
      query.folderId = filters.folderId === null
        ? { $in: [null, undefined] }
        : filters.folderId;
    }

    const [data, total] = await Promise.all([
      this.model
        .find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.model.countDocuments(query).exec(),
    ]);

    return {
      data: data.map((doc) => FileMapper.toDomain(doc as any)),
      total,
      page,
      limit,
    };
  }

  async upsertByMessageId(
    tenantId: string,
    messageId: string,
    data: Partial<FileType>,
  ): Promise<{ file: FileType; isNew: boolean }> {
    // Check if exists first to determine isNew (avoids rawResult typing issues)
    const existing = await this.model
      .findOne({ tenantId, messageId })
      .lean()
      .exec();

    const doc = await this.model.findOneAndUpdate(
      { tenantId, messageId },
      {
        $setOnInsert: {
          tenantId,
          messageId,
          path: data.path,
          fileName: data.fileName,
          category: data.category ?? 'omni_media',
          source: data.source ?? 'omni_inbound',
          accessLevel: data.accessLevel ?? 'tenant',
          allowedUserIds: data.allowedUserIds ?? [],
          tags: data.tags ?? [],
          folderId: data.folderId ?? null,
          isDeleted: false,
        },
        $set: {
          mimeType: data.mimeType,
          fileSize: data.fileSize,
          checksum: data.checksum,
          status: data.status ?? 'ready',
          uploadedBy: data.uploadedBy,
          conversationId: data.conversationId,
          thumbnailKey: data.thumbnailKey,
          imageMetadata: data.imageMetadata,
        },
      },
      {
        upsert: true,
        new: true,
      },
    );

    return {
      file: FileMapper.toDomain(doc as any),
      isNew: !existing,
    };
  }

  async softDelete(id: string): Promise<NullableType<FileType>> {
    const doc = await this.model.findByIdAndUpdate(
      id,
      {
        $set: {
          isDeleted: true,
          deletedAt: new Date(),
          status: 'deleted',
        },
      },
      { new: true },
    );
    return doc ? FileMapper.toDomain(doc) : null;
  }

  async hardDelete(id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }

  async updateAccessLevel(
    id: string,
    accessLevel: FileAccessLevel,
    allowedUserIds: string[],
  ): Promise<NullableType<FileType>> {
    const doc = await this.model.findByIdAndUpdate(
      id,
      { $set: { accessLevel, allowedUserIds } },
      { new: true },
    );
    return doc ? FileMapper.toDomain(doc) : null;
  }

  async updateStatus(
    id: string,
    status: FileStatus,
  ): Promise<NullableType<FileType>> {
    const doc = await this.model.findByIdAndUpdate(
      id,
      { $set: { status } },
      { new: true },
    );
    return doc ? FileMapper.toDomain(doc) : null;
  }

  // ── Cloud Drive extensions ────────────────────────────────────

  async rename(id: string, newName: string): Promise<NullableType<FileType>> {
    const doc = await this.model.findByIdAndUpdate(
      id,
      { $set: { fileName: newName } },
      { new: true },
    );
    return doc ? FileMapper.toDomain(doc) : null;
  }

  async moveToFolder(
    id: string,
    folderId: string | null,
  ): Promise<NullableType<FileType>> {
    const doc = await this.model.findByIdAndUpdate(
      id,
      { $set: { folderId: folderId ?? null } },
      { new: true },
    );
    return doc ? FileMapper.toDomain(doc) : null;
  }

  async bulkMoveToFolder(
    ids: string[],
    folderId: string | null,
  ): Promise<number> {
    const result = await this.model.updateMany(
      { _id: { $in: ids } },
      { $set: { folderId: folderId ?? null } },
    );
    return result.modifiedCount;
  }

  async bulkSoftDelete(ids: string[]): Promise<number> {
    const result = await this.model.updateMany(
      { _id: { $in: ids } },
      {
        $set: {
          isDeleted: true,
          deletedAt: new Date(),
          status: 'deleted',
        },
      },
    );
    return result.modifiedCount;
  }

  async restore(id: string): Promise<NullableType<FileType>> {
    const doc = await this.model.findByIdAndUpdate(
      id,
      {
        $set: {
          isDeleted: false,
          status: 'ready',
        },
        $unset: { deletedAt: 1 },
      },
      { new: true },
    );
    return doc ? FileMapper.toDomain(doc) : null;
  }

  async findTrashed(
    tenantId: string,
    pagination?: PaginationOptions,
  ): Promise<PaginatedResult<FileType>> {
    const page = pagination?.page ?? DEFAULT_PAGE;
    const limit = pagination?.limit ?? DEFAULT_LIMIT;

    const query: FilterQuery<FileSchemaClass> = {
      tenantId,
      isDeleted: true,
    };

    const [data, total] = await Promise.all([
      this.model
        .find(query)
        .sort({ deletedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.model.countDocuments(query).exec(),
    ]);

    return {
      data: data.map((doc) => FileMapper.toDomain(doc as any)),
      total,
      page,
      limit,
    };
  }

  async findTopBySize(
    tenantId: string,
    limit = 10,
  ): Promise<FileType[]> {
    const docs = await this.model
      .find({
        tenantId,
        isDeleted: { $ne: true },
        status: 'ready',
      })
      .sort({ fileSize: -1 })
      .limit(limit)
      .lean()
      .exec();

    return docs.map((doc) => FileMapper.toDomain(doc as any));
  }

  async countByTenant(tenantId: string): Promise<number> {
    return this.model.countDocuments({
      tenantId,
      isDeleted: { $ne: true },
    }).exec();
  }

  async countRecentUploads(
    tenantId: string,
    since: Date,
  ): Promise<number> {
    return this.model.countDocuments({
      tenantId,
      isDeleted: { $ne: true },
      createdAt: { $gte: since },
    }).exec();
  }

  async sumFileSizes(tenantId: string): Promise<number> {
    const { Types } = await import('mongoose');
    const result = await this.model.aggregate([
      {
        $match: {
          tenantId: new Types.ObjectId(tenantId),
          isDeleted: { $ne: true },
        },
      },
      {
        $group: {
          _id: null,
          totalSize: { $sum: '$fileSize' },
        },
      },
    ]).exec();

    return result.length > 0 ? result[0].totalSize : 0;
  }
}
