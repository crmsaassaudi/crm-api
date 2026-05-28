import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import {
  GroupSchemaClass,
  GroupSchemaDocument,
} from '../entities/group.schema';
import { Group } from '../../../../domain/group';
import { GroupMapper } from '../mappers/group.mapper';
import { escapeRegex } from '../../../../../utils/escape-regex';

@Injectable()
export class GroupRepository {
  constructor(
    @InjectModel(GroupSchemaClass.name)
    private readonly model: Model<GroupSchemaDocument>,
  ) {}

  async findAll(
    tenantId: string,
    query?: {
      search?: string;
      isActive?: boolean;
      parentGroupId?: string;
    },
  ): Promise<Group[]> {
    const filter: FilterQuery<GroupSchemaClass> = { tenantId };

    if (query?.search) {
      const safeSearch = escapeRegex(query.search);
      filter.$or = [
        { name: { $regex: safeSearch, $options: 'i' } },
        { description: { $regex: safeSearch, $options: 'i' } },
      ];
    }
    if (query?.isActive !== undefined) {
      filter.isActive = query.isActive;
    }
    if (query?.parentGroupId !== undefined) {
      filter.parentGroupId =
        query.parentGroupId === 'null' ? null : query.parentGroupId;
    }

    const docs = await this.model.find(filter).sort({ name: 1 }).exec();
    return docs.map(GroupMapper.toDomain);
  }

  async findById(tenantId: string, id: string): Promise<Group | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? GroupMapper.toDomain(doc) : null;
  }

  async create(data: Partial<Group>): Promise<Group> {
    const doc = await this.model.create(GroupMapper.toPersistence(data));
    return GroupMapper.toDomain(doc);
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<Group>,
  ): Promise<Group | null> {
    const doc = await this.model
      .findOneAndUpdate(
        { _id: id, tenantId },
        { $set: GroupMapper.toPersistence(data) },
        { new: true },
      )
      .exec();
    return doc ? GroupMapper.toDomain(doc) : null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, tenantId }).exec();
    return result.deletedCount > 0;
  }

  async addMember(
    tenantId: string,
    groupId: string,
    userId: string,
  ): Promise<Group | null> {
    const doc = await this.model
      .findOneAndUpdate(
        { _id: groupId, tenantId },
        { $addToSet: { memberIds: userId } },
        { new: true },
      )
      .exec();
    return doc ? GroupMapper.toDomain(doc) : null;
  }

  async removeMember(
    tenantId: string,
    groupId: string,
    userId: string,
  ): Promise<Group | null> {
    const doc = await this.model
      .findOneAndUpdate(
        { _id: groupId, tenantId },
        { $pull: { memberIds: userId } },
        { new: true },
      )
      .exec();
    return doc ? GroupMapper.toDomain(doc) : null;
  }

  async findGroupsByMember(tenantId: string, userId: string): Promise<Group[]> {
    const docs = await this.model
      .find({ tenantId, memberIds: userId })
      .sort({ name: 1 })
      .exec();
    return docs.map(GroupMapper.toDomain);
  }
}
