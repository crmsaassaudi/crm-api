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
  permissions?: string[];
  permissionOverrides?: Record<string, boolean>;
}

export interface PermissionUser {
  id: string | number;
  tenants?: PermissionUserMembership[];
}

export interface PermissionGroup {
  memberIds?: string[];
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

export const calculateEffectivePermissions = (
  tenant: PermissionTenant,
  user: PermissionUser,
  userGroups: PermissionGroup[] = [],
): Set<string> => {
  // The ceiling for this tenant — Core + explicitly granted feature permissions
  const tenantPermissions = getTenantPermissions(tenant);

  const membership = user.tenants?.find((tenantMembership) =>
    idsEqual(tenantMembership.tenantId, tenant.id),
  );

  const isOwner = idsEqual(tenant.ownerId, user.id);
  const hasAdminRole =
    membership?.roles?.includes('OWNER') ||
    membership?.roles?.includes('ADMIN');

  // Owner / Admin gets everything the tenant is allowed to use
  if (isOwner || hasAdminRole) {
    return tenantPermissions;
  }

  // Regular members: intersect group + personal permissions with tenant ceiling
  const effectivePermissions = new Set<string>();

  userGroups.forEach((group) => {
    group.permissions?.forEach((permission) => {
      if (tenantPermissions.has(permission)) {
        effectivePermissions.add(permission);
      }
    });
  });

  membership?.permissions?.forEach((permission) => {
    if (tenantPermissions.has(permission)) {
      effectivePermissions.add(permission);
    }
  });

  Object.entries(membership?.permissionOverrides ?? {}).forEach(
    ([permission, isGranted]) => {
      if (!tenantPermissions.has(permission)) return;

      if (isGranted) {
        effectivePermissions.add(permission);
      } else {
        effectivePermissions.delete(permission);
      }
    },
  );

  return effectivePermissions;
};

export const canAccess = (
  effectivePermissions: Set<string>,
  action: PermissionAction,
  resource: PermissionResource,
) => {
  const permissionKey = getPermissionKey(action, resource);
  return permissionKey ? effectivePermissions.has(permissionKey) : false;
};
