import {
  Injectable,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GroupRepository } from './infrastructure/persistence/document/repositories/group.repository';
import { Group } from './domain/group';
import { CreateGroupDto, QueryGroupDto, UpdateGroupDto } from './dto/group.dto';
import { UserRepository } from '../users/infrastructure/persistence/user.repository';
import { AuthzAuditService } from '../common/authz-audit/authz-audit.service';
import { CustomRolesService } from '../common/permissions/custom-roles.service';
import { AuthzPermissionCacheService } from '../common/permissions/authz-permission-cache.service';

@Injectable()
export class GroupsService {
  constructor(
    private readonly repository: GroupRepository,
    private readonly cls: ClsService,
    private readonly userRepository: UserRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly audit: AuthzAuditService,
    private readonly customRoles: CustomRolesService,
    private readonly authzCache: AuthzPermissionCacheService,
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
    const validIds = new Set(tenantRoles.map((r) => String(r.id)));
    const unknown = roleIds.filter((id) => !validIds.has(String(id)));
    if (unknown.length) {
      throw new UnprocessableEntityException(
        `Unknown role(s) for this tenant: ${unknown.join(', ')}`,
      );
    }
  }

  /**
   * C-04, third grant path: a group's `permissions` / `roleIds` cascade to every
   * member and every descendant group's members, so writing them is a grant and
   * is bound by the same invariant as a direct or role grant —
   * *you cannot grant what you do not hold*.
   *
   * Without this, `groups:update` is an escalation primitive: attach a powerful
   * role to a group you belong to and inherit it on the next request.
   */
  private async assertCallerCanGrantToGroup(
    tenantId: string,
    permissions?: string[],
    roleIds?: string[],
  ): Promise<void> {
    const roleKeys = roleIds?.length
      ? (await this.customRoles.findAll(tenantId))
          .filter((role) => roleIds.map(String).includes(String(role.id)))
          .flatMap((role) => role.permissions ?? [])
      : [];

    const requested = [...new Set([...(permissions ?? []), ...roleKeys])];
    if (!requested.length) return;

    const callerId = this.cls.get<string>('userId');
    if (!callerId) {
      throw new ForbiddenException(
        'Cannot resolve the acting principal; group permission change refused',
      );
    }

    const explanation = await this.authzCache.explainForUser(
      String(callerId),
      tenantId,
    );
    const held = explanation.fullAccess
      ? new Set(explanation.tenantCeiling)
      : new Set(explanation.effective);

    const escalating = requested.filter((key) => !held.has(key));
    if (escalating.length) {
      throw new ForbiddenException(
        `You cannot grant permission(s) you do not hold yourself: ${escalating.join(', ')}`,
      );
    }
  }

  /**
   * Everything membership of a group confers: its own permissions/roleIds PLUS
   * every ancestor's, because `findGroupsByMemberWithAncestors` resolves the
   * whole chain when computing a member's effective permissions.
   *
   * `parentGroupId` is the *prospective* parent, so this can be asked about a
   * group that does not exist yet or about a re-parent that has not been
   * written.
   */
  private async cascadedGrant(
    tenantId: string,
    group: {
      permissions?: string[] | null;
      roleIds?: string[] | null;
      parentGroupId?: string | null;
    },
  ): Promise<{ permissions: string[]; roleIds: string[] }> {
    const ancestors = group.parentGroupId
      ? await this.repository.findAncestorChain(
          tenantId,
          String(group.parentGroupId),
        )
      : [];

    return {
      permissions: [
        ...(group.permissions ?? []),
        ...ancestors.flatMap((ancestor) => ancestor.permissions ?? []),
      ],
      roleIds: [
        ...(group.roleIds ?? []).map(String),
        ...ancestors.flatMap((ancestor) =>
          (ancestor.roleIds ?? []).map(String),
        ),
      ],
    };
  }

  /**
   * C-04, the membership half of the third grant path.
   *
   * Attaching a role to a group was already bound by "you cannot grant what you
   * do not hold" — but three sibling writes granted exactly the same access
   * while side-stepping that check, because none of them touches `roleIds`:
   *
   *   PATCH /groups/:id { memberIds: [me] }            → I inherit its roles
   *   PATCH /groups/:id { parentGroupId: privileged }  → its members inherit the
   *                                                      ancestor's roles
   *   POST  /groups/:id/members/:me                    → I inherit its roles
   *
   * Each is reachable with an ordinary `groups:edit` / `groups:create` /
   * `groups:manage_members`, so the invariant has to be enforced on the access
   * a write *confers*, not on the field it happens to write.
   */
  private async assertCallerCanGrantGroupMembership(
    tenantId: string,
    group: {
      permissions?: string[] | null;
      roleIds?: string[] | null;
      parentGroupId?: string | null;
    },
  ): Promise<void> {
    const { permissions, roleIds } = await this.cascadedGrant(tenantId, group);
    await this.assertCallerCanGrantToGroup(tenantId, permissions, roleIds);
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
      if (dto.permissions?.length) {
        throw new BadRequestException(
          'Direct group permissions are disabled. Attach a custom role instead.',
        );
      }
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
      // A brand-new group grants its whole cascaded set to every member it is
      // created with, so the check is over the chain, not just `dto.roleIds`.
      await this.assertCallerCanGrantGroupMembership(tenantId, dto);
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
      // Only newly ADDED keys need to be held — removing is de-escalation.
      const addedPermissions = (dto.permissions ?? []).filter(
        (key) => !(previous?.permissions ?? []).includes(key),
      );
      if (addedPermissions.length) {
        throw new BadRequestException(
          'Direct group permissions are disabled. Attach a custom role instead.',
        );
      }
      const addedRoleIds = (dto.roleIds ?? []).filter(
        (roleId) =>
          !(previous?.roleIds ?? []).map(String).includes(String(roleId)),
      );

      const previousMembers = new Set((previous?.memberIds ?? []).map(String));
      const addsMembers = (dto.memberIds ?? []).some(
        (memberId) => !previousMembers.has(String(memberId)),
      );
      const reparents =
        dto.parentGroupId !== undefined &&
        String(dto.parentGroupId ?? '') !==
          String(previous?.parentGroupId ?? '');

      if (addsMembers || reparents) {
        // Either the set of principals or the set of ancestors grew, so the
        // access conferred is the whole post-change chain — see the helper.
        await this.assertCallerCanGrantGroupMembership(tenantId, {
          permissions: dto.permissions ?? previous?.permissions,
          roleIds: dto.roleIds ?? previous?.roleIds,
          parentGroupId:
            dto.parentGroupId !== undefined
              ? dto.parentGroupId
              : previous?.parentGroupId,
        });
      } else {
        // Editing an unrelated field on a powerful group must not require
        // holding its permissions; only newly ADDED keys are a grant.
        await this.assertCallerCanGrantToGroup(
          tenantId,
          addedPermissions,
          addedRoleIds,
        );
      }
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
      // Channels reference groups in their support pool; a dangling id there
      // would silently shrink the eligible agent pool.
      this.eventEmitter.emit('group.deleted', { tenantId, groupId: id });
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
      throw new UnprocessableEntityException(
        'A group cannot be its own parent',
      );
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

    const existing = await this.repository.findById(tenantId, groupId);
    if (!existing) throw new NotFoundException('Group not found');
    // Adding a principal to a group grants them everything the group chain
    // carries — the same grant as attaching the role directly.
    await this.assertCallerCanGrantGroupMembership(tenantId, existing);

    const group = await this.repository.addMember(tenantId, groupId, userId);
    if (!group) throw new NotFoundException('Group not found');
    this.eventEmitter.emit('group.membership.updated', {
      tenantId,
      groupId,
      memberIds: [userId],
    });
    void this.audit.record({
      category: 'GROUP',
      action: 'assign',
      targetType: 'group',
      targetId: groupId,
      summary: `added user ${userId} to group "${group.name}"`,
      after: { memberId: userId },
    });
    return group;
  }

  async removeMember(groupId: string, userId: string): Promise<Group> {
    const tenantId = this.cls.get('tenantId');
    // No grant check: losing group membership can only remove access.
    const group = await this.repository.removeMember(tenantId, groupId, userId);
    if (!group) throw new NotFoundException('Group not found');
    this.eventEmitter.emit('group.membership.updated', {
      tenantId,
      groupId,
      memberIds: [userId],
    });
    void this.audit.record({
      category: 'GROUP',
      action: 'revoke',
      targetType: 'group',
      targetId: groupId,
      summary: `removed user ${userId} from group "${group.name}"`,
      before: { memberId: userId },
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
