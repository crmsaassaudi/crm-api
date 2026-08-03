import {
  CORE_PERMISSIONS,
  PermissionAction,
  PermissionResource,
  getPermissionKey,
} from './permission.constants';

export interface PermissionTenant {
  id: string | number;
  ownerId?: string | number | null;
  /**
   * Explicit list of feature permission keys granted to this tenant ON TOP
   * of the CORE_PERMISSIONS baseline.
   *
   * - `null` / `undefined` → tenant has only CORE_PERMISSIONS (default).
   * - `[]`                 → tenant has only CORE_PERMISSIONS (empty grant).
   * - `['campaigns:view']` → tenant has CORE_PERMISSIONS + campaigns:view.
   */
  availablePermissions?: string[] | null;
  disabledCorePermissions?: string[] | null;
}

export interface PermissionUserMembership {
  tenantId: string;
  roles?: string[];
  /** Custom-role references assigned directly to the user (RBAC). */
  roleIds?: string[];
  /**
   * Per-key exceptions. Only `false` is honoured.
   *
   * A standing `true` here was an ad-hoc grant with no approval, no expiry and
   * no reusable identity; writing one has been refused for a while, and the
   * read path now matches the write path instead of quietly keeping old ones
   * alive. Widening goes through a role or a governed RoleAssignment.
   */
  permissionOverrides?: Record<string, boolean>;
}

export interface PermissionUser {
  id: string | number;
  tenants?: PermissionUserMembership[];
}

export interface PermissionGroup {
  memberIds?: string[];
  permissions?: string[];
  /** Custom-role references assigned to the group (RBAC). */
  roleIds?: string[];
}

/** A tenant custom role (a named, reusable set of permission keys). */
export interface PermissionRole {
  id: string;
  permissions?: string[];
}

const idsEqual = (left?: unknown, right?: unknown) =>
  left != null && right != null && String(left) === String(right);

/**
 * Computes the full set of permission keys available to a tenant.
 *
 * Rule:
 *   tenantPermissions = CORE_PERMISSIONS ∪ tenant.availablePermissions
 *
 * This means:
 *   - Every tenant always has the Core set.
 *   - Feature permissions must be explicitly stored in `availablePermissions`.
 *   - Setting `availablePermissions = null` (default) gives exactly Core.
 */
export const getTenantPermissions = (tenant: PermissionTenant): Set<string> => {
  const disabledCore = new Set(tenant.disabledCorePermissions ?? []);
  const core = new Set<string>(
    CORE_PERMISSIONS.filter((permission) => !disabledCore.has(permission)),
  );
  // Merge any explicitly granted feature permissions on top of Core
  if (tenant.availablePermissions && tenant.availablePermissions.length > 0) {
    tenant.availablePermissions.forEach((p) => core.add(p));
  }
  return core;
};

export const canAccess = (
  effectivePermissions: Set<string>,
  action: PermissionAction,
  resource: PermissionResource,
) => {
  const permissionKey = getPermissionKey(action, resource);
  return permissionKey ? effectivePermissions.has(permissionKey) : false;
};

// Effective-permission explanation (source attribution for admin preview)

export interface ExplainRole {
  id: string;
  name?: string;
  permissions?: string[];
}
export interface ExplainGroup {
  id?: string;
  name?: string;
  permissions?: string[];
  roleIds?: string[];
}
export interface PermissionSource {
  kind: 'owner' | 'admin' | 'role' | 'group' | 'group-role';
  label: string;
}
export interface EffectivePermissionExplanation {
  /** Sorted list of permission keys the user effectively has (bounded by ceiling). */
  effective: string[];
  /** permissionKey → list of sources that grant it. */
  sources: Record<string, PermissionSource[]>;
  /** The tenant ceiling (Core − disabledCore ∪ availableFeature), sorted. */
  tenantCeiling: string[];
  /** True when the user has the full ceiling (owner / admin / super-admin). */
  fullAccess: boolean;
  fullAccessReason?: 'owner' | 'admin' | 'super_admin';
}

/**
 * Same union logic as calculateEffectivePermissions, but records WHERE each
 * effective permission comes from (role / group / group-role / direct /
 * override) so an admin UI can render "what can this user do, and why".
 * Pure & total.
 */
export const explainEffectivePermissions = (
  tenant: PermissionTenant,
  user: PermissionUser,
  userGroups: ExplainGroup[] = [],
  tenantRoles: ExplainRole[] = [],
  opts: { superAdmin?: boolean } = {},
): EffectivePermissionExplanation => {
  const tenantPermissions = getTenantPermissions(tenant);
  const ceiling = [...tenantPermissions].sort();

  const membership = user.tenants?.find((m) => idsEqual(m.tenantId, tenant.id));
  const isOwner = idsEqual(tenant.ownerId, user.id);
  const hasAdminRole =
    membership?.roles?.includes('OWNER') ||
    membership?.roles?.includes('ADMIN');

  if (opts.superAdmin || isOwner || hasAdminRole) {
    const reason: 'owner' | 'admin' | 'super_admin' = opts.superAdmin
      ? 'super_admin'
      : isOwner
        ? 'owner'
        : 'admin';
    const label =
      reason === 'super_admin'
        ? 'Super Admin'
        : reason === 'owner'
          ? 'Owner'
          : 'Admin';
    const sources: Record<string, PermissionSource[]> = {};
    for (const key of ceiling) {
      sources[key] = [
        {
          kind:
            reason === 'admin'
              ? 'admin'
              : reason === 'owner'
                ? 'owner'
                : 'admin',
          label,
        },
      ];
    }
    const effective = new Set(ceiling);
    // Platform super-admin is the break-glass principal. Tenant OWNER/ADMIN is
    // constrainable, so explicit denies must also be reflected by explanations.
    if (!opts.superAdmin) {
      Object.entries(membership?.permissionOverrides ?? {}).forEach(
        ([permission, granted]) => {
          if (granted !== false || !tenantPermissions.has(permission)) return;
          effective.delete(permission);
          delete sources[permission];
        },
      );
    }
    const fullAccess = effective.size === ceiling.length;
    return {
      effective: [...effective].sort(),
      sources,
      tenantCeiling: ceiling,
      fullAccess,
      fullAccessReason: fullAccess ? reason : undefined,
    };
  }

  const roleMap = new Map<string, ExplainRole>(
    tenantRoles.map((role) => [String(role.id), role]),
  );

  const effective = new Set<string>();
  const sources: Record<string, PermissionSource[]> = {};
  const addSource = (perm: string, source: PermissionSource) => {
    if (!tenantPermissions.has(perm)) return;
    effective.add(perm);
    (sources[perm] ??= []).push(source);
  };

  userGroups.forEach((group) => {
    const gname = group.name || 'group';
    group.permissions?.forEach((p) =>
      addSource(p, { kind: 'group', label: `Group: ${gname}` }),
    );
    (group.roleIds ?? []).forEach((rid) => {
      const role = roleMap.get(String(rid));
      role?.permissions?.forEach((p) =>
        addSource(p, {
          kind: 'group-role',
          label: `Group ${gname} · Role ${role.name || rid}`,
        }),
      );
    });
  });

  (membership?.roleIds ?? []).forEach((rid) => {
    const role = roleMap.get(String(rid));
    role?.permissions?.forEach((p) =>
      addSource(p, { kind: 'role', label: `Role: ${role.name || rid}` }),
    );
  });

  // Deny-only, and applied last so it beats every grant above it.
  Object.entries(membership?.permissionOverrides ?? {}).forEach(
    ([perm, granted]) => {
      if (granted !== false || !tenantPermissions.has(perm)) return;
      effective.delete(perm);
      delete sources[perm];
    },
  );

  return {
    effective: [...effective].sort(),
    sources,
    tenantCeiling: ceiling,
    fullAccess: false,
  };
};

/**
 * The permission set the guards enforce.
 *
 * A projection of `explainEffectivePermissions`, not a second implementation.
 * These were two hand-written copies of the same union, and they had already
 * drifted — which meant the "why can this user do X" screen was answering from
 * different code than the check that actually allowed or refused the request.
 * Any future divergence would be invisible until someone hit it in production.
 */
export const calculateEffectivePermissions = (
  tenant: PermissionTenant,
  user: PermissionUser,
  userGroups: PermissionGroup[] = [],
  tenantRoles: PermissionRole[] = [],
): Set<string> =>
  new Set(
    explainEffectivePermissions(
      tenant,
      user,
      userGroups,
      tenantRoles,
    ).effective,
  );
