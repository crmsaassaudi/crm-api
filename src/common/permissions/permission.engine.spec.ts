import {
  calculateEffectivePermissions,
  canAccess,
  getTenantPermissions,
  PermissionTenant,
  PermissionUser,
  PermissionUserMembership,
  PermissionGroup,
} from './permission.engine';

/**
 * Authorization matrix regression suite for the pure permission engine.
 *
 * Covers the RBAC decision surface:
 *   - Owner / Admin ⇒ full tenant ceiling
 *   - Member ⇒ (group ∪ personal) ∩ tenant ceiling
 *   - permissionOverrides allow/deny (deny wins)
 *   - Feature permissions gated by the tenant ceiling
 *   - Unknown permission keys never resolve
 */
describe('permission.engine (authz matrix)', () => {
  const TENANT_ID = 'tenant_1';

  const tenant = (over: Partial<PermissionTenant> = {}): PermissionTenant => ({
    id: TENANT_ID,
    ownerId: 'owner_user',
    availablePermissions: null,
    disabledCorePermissions: null,
    ...over,
  });

  const user = (
    id: string,
    membership: Partial<PermissionUserMembership> = {},
  ): PermissionUser => ({
    id,
    tenants: [{ tenantId: TENANT_ID, roles: [], ...membership }],
  });

  // ── Owner / Admin bypass ──────────────────────────────────────────────
  it('grants the full tenant ceiling to the tenant owner', () => {
    const perms = calculateEffectivePermissions(tenant(), user('owner_user'));
    expect(canAccess(perms, 'view', 'contacts')).toBe(true);
    expect(canAccess(perms, 'delete', 'contacts')).toBe(true);
  });

  it('grants the full tenant ceiling to an ADMIN member', () => {
    const perms = calculateEffectivePermissions(
      tenant(),
      user('admin_user', { roles: ['ADMIN'] }),
    );
    expect(canAccess(perms, 'view', 'deals')).toBe(true);
  });

  it('does NOT grant feature permissions the tenant has not enabled, even to Owner', () => {
    const perms = calculateEffectivePermissions(tenant(), user('owner_user'));
    // contacts:export is a FEATURE permission, not in CORE
    expect(canAccess(perms, 'export', 'contacts')).toBe(false);
  });

  it('grants an enabled feature permission to Owner once on the ceiling', () => {
    const perms = calculateEffectivePermissions(
      tenant({ availablePermissions: ['contacts:export'] }),
      user('owner_user'),
    );
    expect(canAccess(perms, 'export', 'contacts')).toBe(true);
  });

  // ── Member: intersection with ceiling ─────────────────────────────────
  it('grants a member only the personal permissions within the ceiling', () => {
    const perms = calculateEffectivePermissions(
      tenant(),
      user('member_1', { roles: ['MEMBER'], permissions: ['contacts:view'] }),
    );
    expect(canAccess(perms, 'view', 'contacts')).toBe(true);
    expect(canAccess(perms, 'delete', 'contacts')).toBe(false);
  });

  it('unions group permissions into a member effective set', () => {
    const groups: PermissionGroup[] = [{ permissions: ['deals:view'] }];
    const perms = calculateEffectivePermissions(
      tenant(),
      user('member_1', { roles: ['MEMBER'], permissions: ['contacts:view'] }),
      groups,
    );
    expect(canAccess(perms, 'view', 'contacts')).toBe(true);
    expect(canAccess(perms, 'view', 'deals')).toBe(true);
  });

  it('drops a personal permission NOT within the tenant ceiling (feature not enabled)', () => {
    const perms = calculateEffectivePermissions(
      tenant(), // contacts:export not enabled
      user('member_1', {
        roles: ['MEMBER'],
        permissions: ['contacts:view', 'contacts:export'],
      }),
    );
    expect(canAccess(perms, 'view', 'contacts')).toBe(true);
    expect(canAccess(perms, 'export', 'contacts')).toBe(false);
  });

  // ── permissionOverrides: deny wins ────────────────────────────────────
  it('removes a granted permission via a deny override', () => {
    const perms = calculateEffectivePermissions(
      tenant(),
      user('member_1', {
        roles: ['MEMBER'],
        permissions: ['contacts:view'],
        permissionOverrides: { 'contacts:view': false },
      }),
    );
    expect(canAccess(perms, 'view', 'contacts')).toBe(false);
  });

  it('adds a ceiling permission via an allow override', () => {
    const perms = calculateEffectivePermissions(
      tenant(),
      user('member_1', {
        roles: ['MEMBER'],
        permissions: [],
        permissionOverrides: { 'contacts:view': true },
      }),
    );
    expect(canAccess(perms, 'view', 'contacts')).toBe(true);
  });

  it('ignores an allow override for a permission outside the ceiling', () => {
    const perms = calculateEffectivePermissions(
      tenant(), // contacts:export not enabled
      user('member_1', {
        roles: ['MEMBER'],
        permissionOverrides: { 'contacts:export': true },
      }),
    );
    expect(canAccess(perms, 'export', 'contacts')).toBe(false);
  });

  // ── Tenant ceiling: disabled core ─────────────────────────────────────
  it('honours disabledCorePermissions on the ceiling', () => {
    const t = tenant({ disabledCorePermissions: ['contacts:delete'] });
    expect(getTenantPermissions(t).has('contacts:delete')).toBe(false);
    const perms = calculateEffectivePermissions(t, user('owner_user'));
    expect(canAccess(perms, 'delete', 'contacts')).toBe(false);
  });

  // ── Role references (RBAC expansion) ──────────────────────────────────
  const ROLES = [
    { id: 'role_sales', permissions: ['contacts:view', 'deals:view'] },
    { id: 'role_export', permissions: ['contacts:export'] },
  ];

  it('expands a role assigned directly to the member', () => {
    const perms = calculateEffectivePermissions(
      tenant(),
      user('member_1', { roles: ['MEMBER'], roleIds: ['role_sales'] }),
      [],
      ROLES,
    );
    expect(canAccess(perms, 'view', 'contacts')).toBe(true);
    expect(canAccess(perms, 'view', 'deals')).toBe(true);
    expect(canAccess(perms, 'delete', 'contacts')).toBe(false);
  });

  it('expands a role assigned to the group (all members inherit)', () => {
    const groups: PermissionGroup[] = [{ roleIds: ['role_sales'] }];
    const perms = calculateEffectivePermissions(
      tenant(),
      user('member_1', { roles: ['MEMBER'] }),
      groups,
      ROLES,
    );
    expect(canAccess(perms, 'view', 'contacts')).toBe(true);
    expect(canAccess(perms, 'view', 'deals')).toBe(true);
  });

  it('still bounds role-granted feature permissions by the tenant ceiling', () => {
    // role_export grants contacts:export but the tenant has not enabled it
    const perms = calculateEffectivePermissions(
      tenant(),
      user('member_1', { roles: ['MEMBER'], roleIds: ['role_export'] }),
      [],
      ROLES,
    );
    expect(canAccess(perms, 'export', 'contacts')).toBe(false);
  });

  it('grants a role-based feature permission once the tenant enables it', () => {
    const perms = calculateEffectivePermissions(
      tenant({ availablePermissions: ['contacts:export'] }),
      user('member_1', { roles: ['MEMBER'], roleIds: ['role_export'] }),
      [],
      ROLES,
    );
    expect(canAccess(perms, 'export', 'contacts')).toBe(true);
  });

  it('ignores an unknown roleId (expands to nothing, no crash)', () => {
    const perms = calculateEffectivePermissions(
      tenant(),
      user('member_1', { roles: ['MEMBER'], roleIds: ['role_ghost'] }),
      [],
      ROLES,
    );
    expect(canAccess(perms, 'view', 'contacts')).toBe(false);
  });

  it('lets a deny override remove a role-granted permission', () => {
    const perms = calculateEffectivePermissions(
      tenant(),
      user('member_1', {
        roles: ['MEMBER'],
        roleIds: ['role_sales'],
        permissionOverrides: { 'deals:view': false },
      }),
      [],
      ROLES,
    );
    expect(canAccess(perms, 'view', 'contacts')).toBe(true);
    expect(canAccess(perms, 'view', 'deals')).toBe(false);
  });

  // ── No membership / unknown keys ──────────────────────────────────────
  it('grants nothing to a user with no membership in the tenant', () => {
    const stranger: PermissionUser = {
      id: 'stranger',
      tenants: [{ tenantId: 'other_tenant', roles: ['ADMIN'] }],
    };
    const perms = calculateEffectivePermissions(tenant(), stranger);
    expect(canAccess(perms, 'view', 'contacts')).toBe(false);
  });

  it('never resolves an unknown action/resource pair', () => {
    const perms = calculateEffectivePermissions(tenant(), user('owner_user'));
    expect(canAccess(perms, 'view' as any, 'nonexistent' as any)).toBe(false);
  });
});
