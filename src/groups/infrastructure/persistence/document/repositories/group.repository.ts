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

  /**
   * Groups the user is a direct member of PLUS every ancestor group up the
   * parentGroupId chain (RBAC group-hierarchy inheritance, C1). Permissions
   * and roleIds granted to a parent group cascade down to child-group members.
   * Cycle-safe (visited set) and bounded (one tenant-scoped load).
   */
  async findGroupsByMemberWithAncestors(
    tenantId: string,
    userId: string,
  ): Promise<Group[]> {
    const all = (await this.model.find({ tenantId }).exec()).map(
      GroupMapper.toDomain,
    );
    const byId = new Map(all.map((g) => [String(g.id), g]));

    const result = new Map<string, Group>();
    const visited = new Set<string>();
    const queue = all.filter((g) => g.memberIds?.some((m) => m === userId));

    while (queue.length) {
      const group = queue.shift()!;
      const id = String(group.id);
      if (visited.has(id)) continue; // cycle / already processed
      visited.add(id);
      result.set(id, group);
      if (group.parentGroupId) {
        const parent = byId.get(String(group.parentGroupId));
        if (parent && !visited.has(String(parent.id))) queue.push(parent);
      }
    }
    return Array.from(result.values());
  }

  /**
   * All descendant group IDs of the given group (children, grandchildren…),
   * used to invalidate the right member caches when a parent group changes.
   * Cycle-safe.
   */
  async findDescendantIds(
    tenantId: string,
    groupId: string,
  ): Promise<string[]> {
    const all = await this.model
      .find({ tenantId }, { _id: 1, parentGroupId: 1 })
      .lean()
      .exec();
    const childrenOf = new Map<string, string[]>();
    for (const g of all as any[]) {
      const parent = g.parentGroupId ? String(g.parentGroupId) : null;
      if (!parent) continue;
      (childrenOf.get(parent) ?? childrenOf.set(parent, []).get(parent)!).push(
        String(g._id),
      );
    }
    const out = new Set<string>();
    const queue = [String(groupId)];
    while (queue.length) {
      const current = queue.shift()!;
      for (const child of childrenOf.get(current) ?? []) {
        if (!out.has(child)) {
          out.add(child);
          queue.push(child);
        }
      }
    }
    return Array.from(out);
  }

  /** Member IDs across a set of group IDs (deduped), for cache invalidation. */
  async findMemberIdsForGroups(
    tenantId: string,
    groupIds: string[],
  ): Promise<string[]> {
    if (groupIds.length === 0) return [];
    const docs = await this.model
      .find({ tenantId, _id: { $in: groupIds } }, { memberIds: 1 })
      .lean()
      .exec();
    const members = new Set<string>();
    for (const d of docs as any[]) {
      for (const m of d.memberIds ?? []) members.add(String(m));
    }
    return Array.from(members);
  }
}
