import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  RoleAssignmentSchemaClass,
  RoleAssignmentDocument,
  AssignmentPrincipalType,
} from './role-assignment.schema';
import { CustomRolesService } from './custom-roles.service';
import { AuthzAuditService } from '../authz-audit/authz-audit.service';

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
  ) {}

  /** Grant a role to a principal (optionally time-bounded). */
  async grant(params: GrantRoleParams): Promise<RoleAssignmentDocument> {
    // The role must exist in this tenant — reject dangling / cross-tenant ids.
    await this.customRoles.findById(params.roleId, params.tenantId);

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
    return doc;
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

    this.invalidate(
      tenantId,
      assignment.principalType,
      assignment.principalId,
    );
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
  ): Promise<RoleAssignmentDocument[]> {
    const where: any = { tenantId };
    if (filter?.principalId) where.principalId = filter.principalId;
    return this.model
      .find(where)
      .sort({ createdAt: -1 })
      .lean()
      .exec() as any;
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
