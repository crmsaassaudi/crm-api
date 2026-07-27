import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ModuleRef } from '@nestjs/core';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  RoleAssignmentSchemaClass,
  RoleAssignmentDocument,
  AssignmentPrincipalType,
} from './role-assignment.schema';
import { CustomRolesService } from './custom-roles.service';
import { AuthzAuditService } from '../authz-audit/authz-audit.service';
import { RoleAssignment } from './domain/role-assignment';
import { RoleAssignmentMapper } from './mappers/role-assignment.mapper';
import { GroupRepository } from '../../groups/infrastructure/persistence/document/repositories/group.repository';
import { UserRepository } from '../../users/infrastructure/persistence/user.repository';
import type { AuthzPermissionCacheService } from './authz-permission-cache.service';
import { AUTHZ_PERMISSION_CACHE } from './authz.tokens';

export interface GrantRoleParams {
  tenantId: string;
  principalType: AssignmentPrincipalType;
  principalId: string;
  roleId: string;
  grantedById: string;
  /** Absolute expiry for a JIT/temporary grant; omit for a permanent grant. */
  expiresAt?: Date | null;
  reason?: string | null;
}

/**
 * RoleAssignmentService — governed, auditable role grants with JIT expiry.
 *
 * The engine treats standing `roleIds` (embedded) and active assignments as a
 * union; this service owns only the assignment layer. All time comparisons use
 * an injected `now` so behavior is deterministic and testable.
 */
@Injectable()
export class RoleAssignmentService {
  private readonly logger = new Logger(RoleAssignmentService.name);

  constructor(
    @InjectModel(RoleAssignmentSchemaClass.name)
    private readonly model: Model<RoleAssignmentDocument>,
    private readonly customRoles: CustomRolesService,
    private readonly audit: AuthzAuditService,
    private readonly eventEmitter: EventEmitter2,
    private readonly moduleRef: ModuleRef,
    private readonly cls: ClsService,
  ) {}

  /** Grant a role to a principal (optionally time-bounded). */
  async grant(params: GrantRoleParams): Promise<RoleAssignment> {
    // The role must exist in this tenant — reject dangling / cross-tenant ids.
    const role = await this.customRoles.findById(
      params.roleId,
      params.tenantId,
    );

    // The PRINCIPAL must also belong to this tenant (H-03). Validating only the
    // role left the other half open: a grant written against a user or group of
    // another tenant used to resolve into real access, because the evaluator
    // synthesized the missing membership. Both halves are now checked — here at
    // the write, and again at evaluation time.
    await this.assertPrincipalInTenant(
      params.tenantId,
      params.principalType,
      params.principalId,
    );

    // A JIT grant is a role grant like any other — bound by the same
    // anti-escalation invariant as the direct membership-edit path
    // (users.service.ts) and the role-definition path (custom-roles.service.ts).
    // Without this, granting a role was a second, unguarded door: a caller
    // holding only settings:manage_system (needed just to reach this admin
    // page) could grant themselves — or anyone — any tenant role, permanently.
    if (params.principalType === 'user') {
      this.assertNotSelfPrivilegeEdit(params.principalId);
    }
    await this.assertCallerCanGrant(params.tenantId, role.permissions);

    if (params.expiresAt && !(params.expiresAt instanceof Date)) {
      throw new BadRequestException('expiresAt must be a valid date');
    }

    const doc = await this.model.create({
      tenantId: params.tenantId,
      principalType: params.principalType,
      principalId: params.principalId,
      roleId: params.roleId,
      grantedById: params.grantedById,
      expiresAt: params.expiresAt ?? null,
      reason: params.reason ?? null,
      revokedAt: null,
      revokedById: null,
    });

    this.invalidate(params.tenantId, params.principalType, params.principalId);
    void this.audit.record({
      category: 'ASSIGNMENT',
      action: 'assign',
      targetType: params.principalType,
      targetId: params.principalId,
      summary: params.expiresAt
        ? `granted role ${params.roleId} until ${params.expiresAt.toISOString()}`
        : `granted role ${params.roleId} (permanent)`,
      after: {
        roleId: params.roleId,
        expiresAt: params.expiresAt ?? null,
        reason: params.reason ?? null,
      },
    });
    return RoleAssignmentMapper.toDomain(doc);
  }

  /** Soft-revoke an active assignment (preserves the grant history). */
  async revoke(
    tenantId: string,
    assignmentId: string,
    revokedById: string,
    now: Date,
  ): Promise<void> {
    const assignment = await this.model
      .findOne({ _id: assignmentId, tenantId })
      .exec();
    if (!assignment) throw new NotFoundException('Role assignment not found');
    if (assignment.revokedAt) return; // already revoked → idempotent

    assignment.revokedAt = now;
    assignment.revokedById = revokedById;
    await assignment.save();

    this.invalidate(tenantId, assignment.principalType, assignment.principalId);
    void this.audit.record({
      category: 'ASSIGNMENT',
      action: 'revoke',
      targetType: assignment.principalType,
      targetId: assignment.principalId,
      summary: `revoked role ${assignment.roleId}`,
      before: { roleId: assignment.roleId, expiresAt: assignment.expiresAt },
    });
  }

  /**
   * Active role ids for the given principal ids (a user + their groups), as of
   * `now`. Active = not revoked AND (no expiry OR expiry in the future).
   */
  async activeRoleIdsForPrincipals(
    tenantId: string,
    principalIds: string[],
    now: Date,
  ): Promise<string[]> {
    const ids = Array.from(new Set(principalIds.filter(Boolean)));
    if (ids.length === 0) return [];

    const docs = await this.model
      .find({
        tenantId,
        principalId: { $in: ids },
        revokedAt: null,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      })
      .lean()
      .exec();

    return Array.from(new Set(docs.map((d) => String(d.roleId))));
  }

  /** Admin listing for a tenant, newest first (includes expired/revoked). */
  async listForTenant(
    tenantId: string,
    filter?: { principalId?: string },
  ): Promise<RoleAssignment[]> {
    const where: any = { tenantId };
    if (filter?.principalId) where.principalId = filter.principalId;
    const rows = await this.model
      .find(where)
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    return RoleAssignmentMapper.toDomainList(rows);
  }

  /**
   * A grant target must already be a member of the tenant (users) or a group
   * owned by it (groups). Resolved through ModuleRef because the user and group
   * repositories live in feature modules that themselves consume the PDP.
   */
  private async assertPrincipalInTenant(
    tenantId: string,
    principalType: AssignmentPrincipalType,
    principalId: string,
  ): Promise<void> {
    if (principalType === 'group') {
      const groupRepo = this.moduleRef.get(GroupRepository, { strict: false });
      const group = await groupRepo.findById(tenantId, principalId);
      if (!group) {
        throw new UnprocessableEntityException(
          `Group ${principalId} does not belong to this workspace`,
        );
      }
      return;
    }

    const userRepo = this.moduleRef.get(UserRepository, { strict: false });
    const [user] = await userRepo.findByIdsGlobal([principalId]);
    const belongs = user?.tenants?.some(
      (membership: any) => String(membership.tenantId) === String(tenantId),
    );
    if (!belongs) {
      throw new UnprocessableEntityException(
        `User ${principalId} is not a member of this workspace`,
      );
    }
  }

  /** Refuse a JIT grant that targets the caller themselves. */
  private assertNotSelfPrivilegeEdit(targetUserId: string): void {
    const callerId = this.cls.get<string>('userId');
    if (callerId && String(callerId) === String(targetUserId)) {
      throw new ForbiddenException({
        status: 403,
        errors: {
          id: 'You cannot grant yourself a role. Ask another administrator.',
        },
      });
    }
  }

  /**
   * The anti-escalation invariant for the JIT grant path (mirrors
   * users.service.ts / custom-roles.service.ts): requested ⊆ callerEffective.
   * A grant is a permission-container handoff like any other and must be held
   * to the same ceiling as granting the keys directly.
   */
  private async assertCallerCanGrant(
    tenantId: string,
    permissions?: string[],
  ): Promise<void> {
    if (!permissions?.length) return;

    const callerId = this.cls.get<string>('userId');
    if (!callerId) {
      throw new ForbiddenException(
        'Cannot resolve the acting principal; role grant refused',
      );
    }

    // Resolved lazily via ModuleRef: AuthzPermissionCacheService depends on
    // this module's services, so a constructor injection would be circular.
    const authzCache = this.moduleRef.get<AuthzPermissionCacheService>(
      AUTHZ_PERMISSION_CACHE,
      { strict: false },
    );
    const explanation = await authzCache.explainForUser(
      String(callerId),
      tenantId,
    );

    const held = explanation.fullAccess
      ? new Set(explanation.tenantCeiling)
      : new Set(explanation.effective);

    const escalating = [...new Set(permissions)].filter(
      (key) => !held.has(key),
    );

    if (escalating.length) {
      throw new ForbiddenException(
        `You cannot grant permission(s) you do not hold yourself: ${escalating.join(', ')}`,
      );
    }
  }

  private invalidate(
    tenantId: string,
    principalType: AssignmentPrincipalType,
    principalId: string,
  ): void {
    // Reuse the existing invalidation events so a grant/revoke takes effect
    // without waiting for the permission-cache TTL to lapse.
    if (principalType === 'group') {
      this.eventEmitter.emit('group.updated', {
        tenantId,
        groupId: principalId,
      });
    } else {
      this.eventEmitter.emit('user.permissions.updated', {
        tenantId,
        userId: principalId,
      });
    }
  }
}
