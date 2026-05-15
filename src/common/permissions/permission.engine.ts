import {
  ALL_PERMISSIONS,
  PermissionAction,
  PermissionResource,
  getPermissionKey,
} from './permission.constants';

export interface PermissionTenant {
  id: string | number;
  ownerId?: string | number | null;
  availablePermissions?: string[];
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

export const calculateEffectivePermissions = (
  tenant: PermissionTenant,
  user: PermissionUser,
  userGroups: PermissionGroup[] = [],
): Set<string> => {
  const tenantPermissions = new Set(
    tenant.availablePermissions ?? ALL_PERMISSIONS,
  );

  const membership = user.tenants?.find((tenantMembership) =>
    idsEqual(tenantMembership.tenantId, tenant.id),
  );

  const isOwner = idsEqual(tenant.ownerId, user.id);
  const hasAdminRole =
    membership?.roles?.includes('OWNER') ||
    membership?.roles?.includes('ADMIN');

  if (isOwner || hasAdminRole) {
    return tenantPermissions;
  }

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
