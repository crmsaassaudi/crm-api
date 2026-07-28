import { RoleAssignment } from '../domain/role-assignment';

export class RoleAssignmentMapper {
  static toDomain(raw: any): RoleAssignment {
    const entity = new RoleAssignment();
    entity.id = raw._id?.toString() ?? raw.id?.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.principalType = raw.principalType;
    entity.principalId = raw.principalId?.toString();
    entity.roleId = raw.roleId?.toString();
    entity.grantedById = raw.grantedById?.toString();
    entity.approvalStatus = raw.approvalStatus ?? 'approved';
    entity.approvals = (raw.approvals ?? []).map((approval: any) => ({
      approverId: String(approval.approverId),
      approvedAt: approval.approvedAt,
    }));
    entity.approvedAt = raw.approvedAt ?? null;
    entity.rejectedById = raw.rejectedById ?? null;
    entity.rejectedAt = raw.rejectedAt ?? null;
    entity.expiresAt = raw.expiresAt ?? null;
    entity.reason = raw.reason ?? null;
    entity.revokedAt = raw.revokedAt ?? null;
    entity.revokedById = raw.revokedById ?? null;
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }

  static toDomainList(raws: any[]): RoleAssignment[] {
    return (raws ?? []).map((raw) => RoleAssignmentMapper.toDomain(raw));
  }
}
