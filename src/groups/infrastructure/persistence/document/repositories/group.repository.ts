import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import {
  GroupSchemaClass,
  GroupSchemaDocument,
} from '../entities/group.schema';
import { Group } from '../../../../domain/group';
import { GroupMapper } from '../mappers/group.mapper';

@Injectable()
export class GroupRepository {
  constructor(
    @InjectModel(GroupSchemaClass.name)
    private readonly model: Model<GroupSchemaDocument>,
  ) {}

  async findAll(
    tenant: string,
    query?: {
      search?: string;
      isActive?: boolean;
      parentGroup?: string;
    },
  ): Promise<Group[]> {
    const filter: FilterQuery<GroupSchemaClass> = { tenant };

    if (query?.search) {
      filter.$or = [
        { name: { $regex: query.search, $options: 'i' } },
        { description: { $regex: query.search, $options: 'i' } },
      ];
    }
    if (query?.isActive !== undefined) {
      filter.isActive = query.isActive;
    }
    if (query?.parentGroup !== undefined) {
      filter.parentGroup =
        query.parentGroup === 'null' ? null : query.parentGroup;
    }

    const docs = await this.model.find(filter).sort({ name: 1 }).exec();
    return docs.map(GroupMapper.toDomain);
  }

  async findById(tenant: string, id: string): Promise<Group | null> {
    const doc = await this.model.findOne({ _id: id, tenant }).exec();
    return doc ? GroupMapper.toDomain(doc) : null;
  }

  async create(data: Partial<Group>): Promise<Group> {
    const doc = await this.model.create(GroupMapper.toPersistence(data));
    return GroupMapper.toDomain(doc);
  }

  async update(
    tenant: string,
    id: string,
    data: Partial<Group>,
  ): Promise<Group | null> {
    const doc = await this.model
      .findOneAndUpdate(
        { _id: id, tenant },
        { $set: GroupMapper.toPersistence(data) },
        { new: true },
      )
      .exec();
    return doc ? GroupMapper.toDomain(doc) : null;
  }

  async delete(tenant: string, id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, tenant }).exec();
    return result.deletedCount > 0;
  }

  async addMember(
    tenant: string,
    groupId: string,
    userId: string,
  ): Promise<Group | null> {
    const doc = await this.model
      .findOneAndUpdate(
        { _id: groupId, tenant },
        { $addToSet: { members: userId } },
        { new: true },
      )
      .exec();
    return doc ? GroupMapper.toDomain(doc) : null;
  }

  async removeMember(
    tenant: string,
    groupId: string,
    userId: string,
  ): Promise<Group | null> {
    const doc = await this.model
      .findOneAndUpdate(
        { _id: groupId, tenant },
        { $pull: { members: userId } },
        { new: true },
      )
      .exec();
    return doc ? GroupMapper.toDomain(doc) : null;
  }

  async findGroupsByMember(tenant: string, userId: string): Promise<Group[]> {
    const docs = await this.model
      .find({ tenant, members: userId })
      .sort({ name: 1 })
      .exec();
    return docs.map(GroupMapper.toDomain);
  }
}
