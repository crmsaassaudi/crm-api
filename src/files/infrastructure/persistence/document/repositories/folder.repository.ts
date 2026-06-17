import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import { ClsService } from 'nestjs-cls';

import {
  FolderSchemaClass,
  FolderSchemaDocument,
} from '../entities/folder.schema';
import { FolderType } from '../../../../domain/folder';
import { FolderMapper } from '../mappers/folder.mapper';
import { NullableType } from '../../../../../utils/types/nullable.type';

@Injectable()
export class FolderDocumentRepository {
  constructor(
    @InjectModel(FolderSchemaClass.name)
    private readonly model: Model<FolderSchemaDocument>,
    private readonly cls: ClsService,
  ) {}

  async create(
    data: Omit<FolderType, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<FolderType> {
    const doc = new this.model({
      ...data,
      tenantId: data.tenantId ?? this.cls.get('tenantId'),
    });
    const saved = await doc.save();
    return FolderMapper.toDomain(saved);
  }

  async findById(id: string): Promise<NullableType<FolderType>> {
    const doc = await this.model.findById(id).lean().exec();
    return doc ? FolderMapper.toDomain(doc as any) : null;
  }

  async findByParent(
    tenantId: string,
    parentId: string | null,
    includeDeleted = false,
  ): Promise<FolderType[]> {
    const query: FilterQuery<FolderSchemaClass> = {
      tenantId,
      parentId: parentId ?? null,
    };
    if (!includeDeleted) {
      query.isDeleted = { $ne: true };
    }

    const docs = await this.model.find(query).sort({ name: 1 }).lean().exec();
    return docs.map((doc) => FolderMapper.toDomain(doc as any));
  }

  async findByTenant(
    tenantId: string,
    includeDeleted = false,
  ): Promise<FolderType[]> {
    const query: FilterQuery<FolderSchemaClass> = { tenantId };
    if (!includeDeleted) {
      query.isDeleted = { $ne: true };
    }

    const docs = await this.model.find(query).sort({ path: 1 }).lean().exec();
    return docs.map((doc) => FolderMapper.toDomain(doc as any));
  }

  async rename(id: string, name: string): Promise<NullableType<FolderType>> {
    const doc = await this.model.findByIdAndUpdate(
      id,
      { $set: { name } },
      { new: true },
    );
    return doc ? FolderMapper.toDomain(doc) : null;
  }

  async updateColor(
    id: string,
    color: string,
  ): Promise<NullableType<FolderType>> {
    const doc = await this.model.findByIdAndUpdate(
      id,
      { $set: { color } },
      { new: true },
    );
    return doc ? FolderMapper.toDomain(doc) : null;
  }

  async move(
    id: string,
    newParentId: string | null,
    newPath: string,
    newDepth: number,
  ): Promise<NullableType<FolderType>> {
    const doc = await this.model.findByIdAndUpdate(
      id,
      {
        $set: {
          parentId: newParentId,
          path: newPath,
          depth: newDepth,
        },
      },
      { new: true },
    );
    return doc ? FolderMapper.toDomain(doc) : null;
  }

  /**
   * Update all descendant paths when a folder moves.
   * Uses regex on materialized path to find descendants.
   */
  async updateDescendantPaths(
    tenantId: string,
    oldPathPrefix: string,
    newPathPrefix: string,
    depthDelta: number,
  ): Promise<number> {
    // Find all descendants whose path starts with the old prefix
    const descendants = await this.model
      .find({
        tenantId,
        path: { $regex: `^${this.escapeRegex(oldPathPrefix)}/` },
      })
      .exec();

    let updated = 0;
    for (const desc of descendants) {
      const newPath = desc.path.replace(oldPathPrefix, newPathPrefix);
      await this.model.updateOne(
        { _id: desc._id },
        {
          $set: {
            path: newPath,
            depth: (desc.depth ?? 0) + depthDelta,
          },
        },
      );
      updated += 1;
    }
    return updated;
  }

  async softDelete(id: string): Promise<NullableType<FolderType>> {
    const doc = await this.model.findByIdAndUpdate(
      id,
      {
        $set: {
          isDeleted: true,
          deletedAt: new Date(),
        },
      },
      { new: true },
    );
    return doc ? FolderMapper.toDomain(doc) : null;
  }

  async restore(id: string): Promise<NullableType<FolderType>> {
    const doc = await this.model.findByIdAndUpdate(
      id,
      {
        $set: { isDeleted: false },
        $unset: { deletedAt: 1 },
      },
      { new: true },
    );
    return doc ? FolderMapper.toDomain(doc) : null;
  }

  async hardDelete(id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }

  /** Check if a folder name already exists under the same parent */
  async existsByName(
    tenantId: string,
    parentId: string | null,
    name: string,
    excludeId?: string,
  ): Promise<boolean> {
    const query: FilterQuery<FolderSchemaClass> = {
      tenantId,
      parentId: parentId ?? null,
      name,
      isDeleted: { $ne: true },
    };
    if (excludeId) {
      query._id = { $ne: excludeId };
    }
    const count = await this.model.countDocuments(query).exec();
    return count > 0;
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
