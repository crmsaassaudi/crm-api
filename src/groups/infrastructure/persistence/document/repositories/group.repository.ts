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
   * Hard bound on how far a parent walk may climb. The hierarchy is kept
   * acyclic by `GroupsService.assertNoCycle`, and the visited set below already
   * makes a cycle terminate; this is the second belt, so a hierarchy corrupted
   * outside the service can never spin the walk.
   */
  private static readonly MAX_HIERARCHY_DEPTH = 32;

  /**
   * Walk up the parentGroupId chain, one level per query, starting from the
   * given frontier of group ids. Returns the groups visited, excluding any id
   * already in `visited` (which it also mutates).
   *
   * Level-at-a-time rather than loading the tenant's whole group collection:
   * the walk is O(depth) small `_id`-indexed reads instead of O(groups in
   * tenant), and this runs on every permission resolution.
   */
  private async climbParents(
    tenantId: string,
    frontier: string[],
    visited: Set<string>,
  ): Promise<Group[]> {
    const collected: Group[] = [];
    let next = frontier.filter((id) => !visited.has(id));

    for (
      let depth = 0;
      depth < GroupRepository.MAX_HIERARCHY_DEPTH && next.length;
      depth++
    ) {
      next.forEach((id) => visited.add(id));
      const docs = await this.model
        .find({ _id: { $in: next }, tenantId })
        .exec();
      const groups = docs.map(GroupMapper.toDomain);
      collected.push(...groups);

      next = groups
        .map((group) => group.parentGroupId && String(group.parentGroupId))
        .filter((id): id is string => !!id && !visited.has(id));
    }

    return collected;
  }

  /**
   * Groups the user is a direct member of PLUS every ancestor group up the
   * parentGroupId chain (RBAC group-hierarchy inheritance, C1). Permissions
   * and roleIds granted to a parent group cascade down to child-group members.
   * Cycle-safe (visited set) and depth-bounded.
   */
  async findGroupsByMemberWithAncestors(
    tenantId: string,
    userId: string,
  ): Promise<Group[]> {
    const direct = (
      await this.model.find({ tenantId, memberIds: userId }).exec()
    ).map(GroupMapper.toDomain);

    const visited = new Set(direct.map((group) => String(group.id)));
    const parents = direct
      .map((group) => group.parentGroupId && String(group.parentGroupId))
      .filter((id): id is string => !!id);

    const ancestors = await this.climbParents(tenantId, parents, visited);
    return [...direct, ...ancestors];
  }

  /**
   * The given group plus every ancestor above it. Used to answer "what does
   * membership of this group actually grant", which is the union of the whole
   * chain — not just the group's own roleIds.
   */
  async findAncestorChain(tenantId: string, groupId: string): Promise<Group[]> {
    return this.climbParents(tenantId, [String(groupId)], new Set());
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
