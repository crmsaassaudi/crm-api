/**
 * RBAC combination matrix generator.
 *
 * The permission engine is pure and total, so the whole grant-source space is
 * cheap to enumerate exhaustively instead of sampling it by hand.
 *
 * 12 independent grant sources → 2^12 = 4096 subject shapes. Each shape is
 * evaluated by the real engine and by an INDEPENDENT reference oracle below.
 * The oracle is deliberately structured differently (ordered layer reduction
 * rather than mutate-a-set) so a copy-paste bug cannot make both agree.
 *
 * Probe keys (all CORE except CONTACTS_EXPORT, which is plan-gated):
 *   contacts:view  contacts:edit  contacts:delete  tickets:view
 *   tickets:edit   users:view     contacts:export (outside the default ceiling)
 */

import type {
  PermissionGroup,
  PermissionRole,
  PermissionTenant,
  PermissionUser,
} from '../../../common/permissions/permission.engine';

export const KEY = {
  CONTACTS_VIEW: 'contacts:view',
  CONTACTS_EDIT: 'contacts:edit',
  CONTACTS_DELETE: 'contacts:delete',
  TICKETS_VIEW: 'tickets:view',
  TICKETS_EDIT: 'tickets:edit',
  USERS_VIEW: 'users:view',
  /** Feature permission — NOT in CORE_PERMISSIONS, so outside the default ceiling. */
  CONTACTS_EXPORT: 'contacts:export',
} as const;

/** Every key the matrix asserts on. */
export const PROBE_KEYS: string[] = Object.values(KEY);

export const TENANT_ID = '000000000000000000000001';
export const USER_ID = '000000000000000000000002';

/** Role catalog referenced by roleId from users and groups. */
export const ROLE_CATALOG: PermissionRole[] = [
  { id: 'role-edit', permissions: [KEY.CONTACTS_EDIT] },
  { id: 'role-users', permissions: [KEY.USERS_VIEW] },
  { id: 'role-ancestor', permissions: [KEY.TICKETS_EDIT] },
  { id: 'role-jit', permissions: [KEY.CONTACTS_DELETE] },
  /** Referenced by nobody's catalog on purpose — dangling reference case. */
  { id: 'role-dangling-never-registered', permissions: [KEY.CONTACTS_EXPORT] },
];

/** The 12 independent grant-source switches. Order is stable: it names the case. */
export const SOURCE_FLAGS = [
  'tenantOwner',
  'adminFlag',
  'directPermission',
  'directRole',
  'groupPermission',
  'groupRole',
  'ancestorGroupRole',
  'jitRole',
  'overrideAllow',
  'overrideDeny',
  'grantOutsideCeiling',
  'disabledCore',
] as const;

export type SourceFlag = (typeof SOURCE_FLAGS)[number];
export type Sources = Record<SourceFlag, boolean>;

export interface MatrixCase {
  /** Stable, greppable id, e.g. "rbac-0413[adminFlag,overrideDeny]". */
  id: string;
  sources: Sources;
  tenant: PermissionTenant;
  user: PermissionUser;
  groups: PermissionGroup[];
  roles: PermissionRole[];
}

const bit = (mask: number, index: number) => (mask & (1 << index)) !== 0;

function buildSubject(sources: Sources): Omit<MatrixCase, 'id' | 'sources'> {
  const tenant: PermissionTenant = {
    id: TENANT_ID,
    ownerId: sources.tenantOwner ? USER_ID : '000000000000000000000099',
    availablePermissions: null,
    disabledCorePermissions: sources.disabledCore ? [KEY.USERS_VIEW] : null,
  };

  const directPermissions: string[] = [];
  if (sources.directPermission) directPermissions.push(KEY.CONTACTS_VIEW);
  if (sources.grantOutsideCeiling) directPermissions.push(KEY.CONTACTS_EXPORT);

  const roleIds: string[] = [];
  if (sources.directRole) roleIds.push('role-edit');
  // JIT grants are merged into membership.roleIds upstream by
  // AuthzPermissionCacheService.withAssignmentRoles — the engine sees them as
  // ordinary role references, which is exactly what we model here.
  if (sources.jitRole) roleIds.push('role-jit');

  const overrides: Record<string, boolean> = {};
  if (sources.overrideAllow) overrides[KEY.TICKETS_EDIT] = true;
  if (sources.overrideDeny) overrides[KEY.CONTACTS_VIEW] = false;

  const user: PermissionUser = {
    id: USER_ID,
    tenants: [
      {
        tenantId: TENANT_ID,
        roles: sources.adminFlag ? ['ADMIN'] : ['MEMBER'],
        roleIds,
        permissions: directPermissions,
        permissionOverrides: overrides,
      },
    ],
  };

  const groups: PermissionGroup[] = [];
  if (sources.groupPermission || sources.groupRole) {
    groups.push({
      memberIds: [USER_ID],
      permissions: sources.groupPermission ? [KEY.TICKETS_VIEW] : [],
      roleIds: sources.groupRole ? ['role-users'] : [],
    });
  }
  if (sources.ancestorGroupRole) {
    // The repository flattens the ancestor chain before the engine sees it, so
    // an inherited group arrives as just another entry in the list.
    groups.push({ memberIds: [], permissions: [], roleIds: ['role-ancestor'] });
  }

  return { tenant, user, groups, roles: ROLE_CATALOG };
}

/** All 4096 cases, in a stable order. */
export function generateRbacCases(): MatrixCase[] {
  const cases: MatrixCase[] = [];

  for (let mask = 0; mask < 1 << SOURCE_FLAGS.length; mask++) {
    const sources = Object.fromEntries(
      SOURCE_FLAGS.map((flag, index) => [flag, bit(mask, index)]),
    ) as Sources;

    const active = SOURCE_FLAGS.filter((flag) => sources[flag]);
    const id = `rbac-${String(mask).padStart(4, '0')}[${active.join(',') || 'none'}]`;

    cases.push({ id, sources, ...buildSubject(sources) });
  }

  return cases;
}

// ── Reference oracle ────────────────────────────────────────────────────────
//
// Independently derived from the SPECIFICATION, not from the implementation:
//
//   ceiling  = (CORE − disabledCore) ∪ availableFeature
//   full     = owner ∨ adminFlag                      → ceiling
//   layers   = [groupPerms, groupRoles, directPerms, directRoles]  (union, flat)
//   result   = (⋃ layers ∩ ceiling) then overrides applied last
//
// Expressed as an ordered reduce over layers so its shape does not mirror the
// engine's mutate-a-Set implementation.

export interface OracleInput {
  /** The tenant's real ceiling for the probe keys, supplied by the spec file. */
  coreKeys: string[];
  sources: Sources;
}

export function oracleEffectiveKeys(input: OracleInput): Set<string> {
  const { coreKeys, sources } = input;

  const ceiling = new Set(
    coreKeys.filter((key) => !(sources.disabledCore && key === KEY.USERS_VIEW)),
  );

  if (sources.tenantOwner || sources.adminFlag) {
    return ceiling;
  }

  const layers: string[][] = [
    sources.groupPermission ? [KEY.TICKETS_VIEW] : [],
    sources.groupRole ? [KEY.USERS_VIEW] : [],
    sources.ancestorGroupRole ? [KEY.TICKETS_EDIT] : [],
    sources.directPermission ? [KEY.CONTACTS_VIEW] : [],
    sources.grantOutsideCeiling ? [KEY.CONTACTS_EXPORT] : [],
    sources.directRole ? [KEY.CONTACTS_EDIT] : [],
    sources.jitRole ? [KEY.CONTACTS_DELETE] : [],
  ];

  const granted = layers
    .reduce<string[]>((accumulator, layer) => [...accumulator, ...layer], [])
    .filter((key) => ceiling.has(key));

  const result = new Set(granted);

  // Overrides are the last word, and are themselves clamped by the ceiling.
  if (sources.overrideAllow && ceiling.has(KEY.TICKETS_EDIT)) {
    result.add(KEY.TICKETS_EDIT);
  }
  if (sources.overrideDeny && ceiling.has(KEY.CONTACTS_VIEW)) {
    result.delete(KEY.CONTACTS_VIEW);
  }

  return result;
}
