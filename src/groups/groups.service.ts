import {
  Injectable,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GroupRepository } from './infrastructure/persistence/document/repositories/group.repository';
import { Group } from './domain/group';
import { CreateGroupDto, QueryGroupDto, UpdateGroupDto } from './dto/group.dto';
import { UserRepository } from '../users/infrastructure/persistence/user.repository';
import { AuthzAuditService } from '../common/authz-audit/authz-audit.service';
import { CustomRolesService } from '../common/permissions/custom-roles.service';

@Injectable()
export class GroupsService {
  constructor(
    private readonly repository: GroupRepository,
    private readonly cls: ClsService,
    private readonly userRepository: UserRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly audit: AuthzAuditService,
    private readonly customRoles: CustomRolesService,
  ) {}

  /**
   * Reject role references that do not exist in this tenant's custom-role
   * catalog — a group must not carry dangling / cross-tenant roleIds.
   */
  private async assertRoleIdsBelongToTenant(
    tenantId: string,
    roleIds?: string[],
  ): Promise<void> {
    if (!roleIds?.length) return;
    const tenantRoles = await this.customRoles.findAll(tenantId);
    const validIds = new Set(tenantRoles.map((r: any) => String(r._id ?? r.id)));
    const unknown = roleIds.filter((id) => !validIds.has(String(id)));
    if (unknown.length) {
      throw new UnprocessableEntityException(
        `Unknown role(s) for this tenant: ${unknown.join(', ')}`,
      );
    }
  }

  async findAll(query?: QueryGroupDto): Promise<Group[]> {
    const tenantId = this.cls.get('tenantId');
    return this.repository.findAll(tenantId, query);
  }

  async findById(id: string): Promise<Group> {
    const tenantId = this.cls.get('tenantId');
    const group = await this.repository.findById(tenantId, id);
    if (!group) throw new NotFoundException('Group not found');
    return group;
  }

  async create(dto: CreateGroupDto): Promise<Group> {
    const tenantId = this.cls.get('tenantId');
    try {
      if (dto.parentGroupId) {
        const parent = await this.repository.findById(
          tenantId,
          dto.parentGroupId,
        );
        if (!parent) {
          throw new UnprocessableEntityException('Parent group not found');
        }
      }
      await this.assertRoleIdsBelongToTenant(tenantId, dto.roleIds);
      const group = await this.repository.create({ ...dto, tenantId });
      await this.emitGroupUpdated(tenantId, group);
      void this.audit.record({
        category: 'GROUP',
        action: 'create',
        targetType: 'group',
        targetId: group.id,
        summary: `created group "${group.name}"`,
        after: {
          name: group.name,
          permissions: group.permissions,
          roleIds: group.roleIds,
          parentGroupId: group.parentGroupId,
        },
      });
      return group;
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException(
          `A group named "${dto.name}" already exists in this tenant`,
        );
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateGroupDto): Promise<Group> {
    const tenantId = this.cls.get('tenantId');
    try {
      if (dto.parentGroupId !== undefined && dto.parentGroupId !== null) {
        await this.assertNoCycle(tenantId, id, dto.parentGroupId);
      }
      await this.assertRoleIdsBelongToTenant(tenantId, dto.roleIds);
      const previous = await this.repository.findById(tenantId, id);
      const group = await this.repository.update(tenantId, id, dto);
      if (!group) throw new NotFoundException('Group not found');
      await this.emitGroupUpdated(tenantId, group, previous?.memberIds);
      void this.audit.record({
        category: 'GROUP',
        action: 'update',
        targetType: 'group',
        targetId: group.id,
        summary: `updated group "${group.name}"`,
        before: previous && {
          permissions: previous.permissions,
          roleIds: previous.roleIds,
          parentGroupId: previous.parentGroupId,
        },
        after: {
          permissions: group.permissions,
          roleIds: group.roleIds,
          parentGroupId: group.parentGroupId,
        },
      });
      return group;
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException(
          `A group named "${dto.name}" already exists in this tenant`,
        );
      }
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    const tenantId = this.cls.get('tenantId');
    const previous = await this.repository.findById(tenantId, id);
    const deleted = await this.repository.delete(tenantId, id);
    if (!deleted) throw new NotFoundException('Group not found');
    if (previous) {
      await this.emitGroupUpdated(tenantId, previous);
      void this.audit.record({
        category: 'GROUP',
        action: 'delete',
        targetType: 'group',
        targetId: id,
        summary: `deleted group "${previous.name}"`,
        before: {
          name: previous.name,
          permissions: previous.permissions,
          roleIds: previous.roleIds,
        },
      });
    }
  }

  /**
   * Prevent a group hierarchy cycle: the new parent must not be the group
   * itself nor any of its descendants (which would create a loop that the
   * ancestor walk relies on being acyclic).
   */
  private async assertNoCycle(
    tenantId: string,
    groupId: string,
    parentGroupId: string,
  ): Promise<void> {
    if (String(parentGroupId) === String(groupId)) {
      throw new UnprocessableEntityException('A group cannot be its own parent');
    }
    const parent = await this.repository.findById(tenantId, parentGroupId);
    if (!parent) {
      throw new UnprocessableEntityException('Parent group not found');
    }
    const descendants = await this.repository.findDescendantIds(
      tenantId,
      groupId,
    );
    if (descendants.includes(String(parentGroupId))) {
      throw new UnprocessableEntityException(
        'Cannot set parent group: this would create a cycle',
      );
    }
  }

  async addMember(groupId: string, userId: string): Promise<Group> {
    const tenantId = this.cls.get('tenantId');

    // Validate user belongs to this tenant before adding to group
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const belongsToTenant = user.tenants?.some(
      (t) => t.tenantId?.toString() === tenantId.toString(),
    );
    if (!belongsToTenant) {
      throw new UnprocessableEntityException(
        'User must belong to this tenant before being added to a group',
      );
    }

    const group = await this.repository.addMember(tenantId, groupId, userId);
    if (!group) throw new NotFoundException('Group not found');
    this.eventEmitter.emit('group.membership.updated', {
      tenantId,
      groupId,
      memberIds: [userId],
    });
    return group;
  }

  async removeMember(groupId: string, userId: string): Promise<Group> {
    const tenantId = this.cls.get('tenantId');
    const group = await this.repository.removeMember(tenantId, groupId, userId);
    if (!group) throw new NotFoundException('Group not found');
    this.eventEmitter.emit('group.membership.updated', {
      tenantId,
      groupId,
      memberIds: [userId],
    });
    return group;
  }

  private async emitGroupUpdated(
    tenantId: string,
    group: Group,
    previousMemberIds: string[] = [],
  ): Promise<void> {
    // A group's permissions/roleIds cascade to descendant groups' members
    // (C1). Invalidate this group's members AND all descendant members.
    const descendantIds = await this.repository.findDescendantIds(
      tenantId,
      group.id,
    );
    const descendantMembers = await this.repository.findMemberIdsForGroups(
      tenantId,
      descendantIds,
    );

    const memberIds = Array.from(
      new Set(
        [
          ...(group.memberIds ?? []),
          ...previousMemberIds,
          ...descendantMembers,
        ].map(String),
      ),
    );

    this.eventEmitter.emit('group.updated', {
      tenantId,
      groupId: group.id,
      memberIds,
    });
  }
}
