/**
 * Auto-generated RBAC matrix — every grant-source combination × 7 probe keys.
 *
 * Runs the REAL engine against an independent oracle. A mismatch is reported
 * with the case id (e.g. `rbac-0413[adminFlag,overrideDeny]`) so the failing
 * combination is reproducible by name.
 *
 * This suite is the coverage floor for permission.engine.ts. It replaces the
 * hand-written sampling that could only ever cover the combinations someone
 * thought of.
 */

import {
  calculateEffectivePermissions,
  explainEffectivePermissions,
  getTenantPermissions,
} from '../../common/permissions/permission.engine';
import { CORE_PERMISSIONS } from '../../common/permissions/permission.constants';
import {
  generateRbacCases,
  oracleEffectiveKeys,
  KEY,
  PROBE_KEYS,
  TENANT_ID,
  USER_ID,
  ROLE_CATALOG,
  SOURCE_FLAGS,
} from './matrix/rbac-matrix';

const CASES = generateRbacCases();
const CORE_PROBE_KEYS = PROBE_KEYS.filter((key) =>
  CORE_PERMISSIONS.includes(key),
);

describe('RBAC matrix (generated)', () => {
  it('should enumerate the full grant-source space', () => {
    const expected = 2 ** SOURCE_FLAGS.length;
    expect(CASES).toHaveLength(expected);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(expected);
  });

  it('should classify probe keys correctly against CORE_PERMISSIONS', () => {
    // The matrix depends on contacts:export being plan-gated. If the product
    // moves it into CORE, this assertion fails loudly rather than silently
    // turning the "outside the ceiling" cases into no-ops.
    expect(CORE_PERMISSIONS).not.toContain(KEY.CONTACTS_EXPORT);
    expect(CORE_PROBE_KEYS).toHaveLength(PROBE_KEYS.length - 1);
  });

  it('should agree with the reference oracle for every combination and probe key', () => {
    const mismatches: string[] = [];

    for (const testCase of CASES) {
      const actual = calculateEffectivePermissions(
        testCase.tenant,
        testCase.user,
        testCase.groups,
        testCase.roles,
      );
      const expected = oracleEffectiveKeys({
        coreKeys: CORE_PROBE_KEYS,
        sources: testCase.sources,
      });

      for (const key of PROBE_KEYS) {
        const got = actual.has(key);
        const want = expected.has(key);
        if (got !== want) {
          mismatches.push(
            `${testCase.id} key=${key} engine=${got} oracle=${want}`,
          );
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('should never grant anything outside the tenant ceiling', () => {
    const violations: string[] = [];

    for (const testCase of CASES) {
      const ceiling = getTenantPermissions(testCase.tenant);
      const actual = calculateEffectivePermissions(
        testCase.tenant,
        testCase.user,
        testCase.groups,
        testCase.roles,
      );
      for (const key of actual) {
        if (!ceiling.has(key)) violations.push(`${testCase.id} leaked ${key}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('should be monotonic: adding a pure allow source never shrinks the result', () => {
    // Excludes the sources that are not pure allows: overrideDeny removes,
    // disabledCore shrinks the ceiling, and tenantOwner/adminFlag replace the
    // union outright rather than adding to it.
    const allowSources = [
      'directRole',
      'groupPermission',
      'groupRole',
      'ancestorGroupRole',
      'jitRole',
    ] as const;

    const shrinks: string[] = [];
    // Index by source-bitmask so widening is an O(1) lookup, not a scan.
    const byMask = new Map(
      CASES.map((testCase) => [
        Object.values(testCase.sources).reduce(
          (mask, value, index) => (value ? mask | (1 << index) : mask),
          0,
        ),
        testCase,
      ]),
    );
    const flagIndex = Object.fromEntries(
      Object.keys(CASES[0].sources).map((flag, index) => [flag, index]),
    );

    for (const testCase of CASES) {
      // Skip the full-access short-circuit: it is already the ceiling, and
      // overrideDeny is by definition non-monotonic.
      if (testCase.sources.tenantOwner || testCase.sources.adminFlag) continue;
      if (testCase.sources.overrideDeny) continue;

      const base = calculateEffectivePermissions(
        testCase.tenant,
        testCase.user,
        testCase.groups,
        testCase.roles,
      );

      const baseMask = Object.values(testCase.sources).reduce(
        (mask, value, index) => (value ? mask | (1 << index) : mask),
        0,
      );

      for (const source of allowSources) {
        if (testCase.sources[source]) continue;
        const widened = byMask.get(baseMask | (1 << flagIndex[source]));
        if (!widened) continue;

        const after = calculateEffectivePermissions(
          widened.tenant,
          widened.user,
          widened.groups,
          widened.roles,
        );
        for (const key of base) {
          if (!after.has(key)) {
            shrinks.push(`${testCase.id} +${source} lost ${key}`);
          }
        }
      }
    }

    expect(shrinks).toEqual([]);
  });

  it('should be idempotent — repeated evaluation is stable', () => {
    for (const testCase of CASES.slice(0, 256)) {
      const first = calculateEffectivePermissions(
        testCase.tenant,
        testCase.user,
        testCase.groups,
        testCase.roles,
      );
      const second = calculateEffectivePermissions(
        testCase.tenant,
        testCase.user,
        testCase.groups,
        testCase.roles,
      );
      expect([...second].sort()).toEqual([...first].sort());
    }
  });
});

describe('explain ≡ calculate (M-03 drift guard)', () => {
  /**
   * The admin "what can this user do, and why" preview is a second
   * implementation of the same algorithm. If the two ever disagree, the preview
   * is lying to the person granting access. This binds them.
   */
  it('should keep explainEffectivePermissions.effective equal to calculateEffectivePermissions', () => {
    const divergences: string[] = [];

    for (const testCase of CASES) {
      const calculated = calculateEffectivePermissions(
        testCase.tenant,
        testCase.user,
        testCase.groups,
        testCase.roles,
      );
      const explained = explainEffectivePermissions(
        testCase.tenant,
        testCase.user,
        testCase.groups.map((group, index) => ({
          id: `g${index}`,
          name: `Group ${index}`,
          permissions: group.permissions ?? [],
          roleIds: group.roleIds ?? [],
        })),
        ROLE_CATALOG.map((role) => ({
          id: role.id,
          name: role.id,
          permissions: role.permissions ?? [],
        })),
      );

      const left = [...calculated].sort().join(',');
      const right = [...explained.effective].sort().join(',');
      if (left !== right) {
        divergences.push(
          `${testCase.id}\n  calc:    ${left}\n  explain: ${right}`,
        );
      }
    }

    expect(divergences).toEqual([]);
  });

  it('should give every effective permission at least one source attribution', () => {
    const unattributed: string[] = [];

    for (const testCase of CASES) {
      const explained = explainEffectivePermissions(
        testCase.tenant,
        testCase.user,
        testCase.groups.map((group, index) => ({
          id: `g${index}`,
          permissions: group.permissions ?? [],
          roleIds: group.roleIds ?? [],
        })),
        ROLE_CATALOG.map((role) => ({
          id: role.id,
          permissions: role.permissions ?? [],
        })),
      );

      for (const key of explained.effective) {
        if (!explained.sources[key]?.length) {
          unattributed.push(`${testCase.id} ${key}`);
        }
      }
    }

    expect(unattributed).toEqual([]);
  });
});

describe('RBAC edge cases the matrix cannot express', () => {
  const tenant = {
    id: TENANT_ID,
    ownerId: null,
    availablePermissions: null,
    disabledCorePermissions: null,
  };

  it('should grant nothing when membership is missing entirely → zero permissions', () => {
    const result = calculateEffectivePermissions(
      tenant,
      { id: USER_ID, tenants: [] },
      [],
      ROLE_CATALOG,
    );
    expect([...result]).toEqual([]);
  });

  it('should grant nothing for a membership in a DIFFERENT tenant → zero permissions', () => {
    const result = calculateEffectivePermissions(
      tenant,
      {
        id: USER_ID,
        tenants: [
          {
            tenantId: '0000000000000000000000ff',
            roles: ['ADMIN'],
            roleIds: ['role-view'],
          },
        ],
      },
      [],
      ROLE_CATALOG,
    );
    expect([...result]).toEqual([]);
  });

  it('should let the first row win for duplicate membership rows', () => {
    const result = calculateEffectivePermissions(
      tenant,
      {
        id: USER_ID,
        tenants: [
          { tenantId: TENANT_ID, roleIds: ['role-view'] },
          { tenantId: TENANT_ID, roleIds: ['role-jit'] },
        ],
      },
      [],
      ROLE_CATALOG,
    );
    // Documents the current `Array.find` semantics. If the data model ever
    // permits duplicates in practice, this is the behaviour to reason about.
    expect(result.has(KEY.CONTACTS_VIEW)).toBe(true);
    expect(result.has(KEY.CONTACTS_DELETE)).toBe(false);
  });

  it('should ignore a roleId referencing a deleted role → ignored, no throw (L-03)', () => {
    const result = calculateEffectivePermissions(
      tenant,
      {
        id: USER_ID,
        tenants: [{ tenantId: TENANT_ID, roleIds: ['role-deleted-yesterday'] }],
      },
      [],
      ROLE_CATALOG,
    );
    expect([...result]).toEqual([]);
  });

  it('should coerce an ObjectId-shaped tenantId correctly (idsEqual)', () => {
    const objectIdLike = { toString: () => TENANT_ID };
    const result = calculateEffectivePermissions(
      { ...tenant, id: objectIdLike as any },
      {
        id: USER_ID,
        tenants: [{ tenantId: objectIdLike as any, roleIds: ['role-view'] }],
      },
      [],
      ROLE_CATALOG,
    );
    expect(result.has(KEY.CONTACTS_VIEW)).toBe(true);
  });

  it('should apply an explicit deny override to an ADMIN', () => {
    const result = calculateEffectivePermissions(
      tenant,
      {
        id: USER_ID,
        tenants: [
          {
            tenantId: TENANT_ID,
            roles: ['ADMIN'],
            permissionOverrides: { [KEY.CONTACTS_VIEW]: false },
          },
        ],
      },
      [],
      ROLE_CATALOG,
    );
    // Explicit deny is the final policy layer even for tenant administrators.
    expect(result.has(KEY.CONTACTS_VIEW)).toBe(false);
  });

  it('should not let a group deny — documents M-01', () => {
    const result = calculateEffectivePermissions(
      tenant,
      {
        id: USER_ID,
        tenants: [{ tenantId: TENANT_ID, roleIds: ['role-view'] }],
      },
      // PermissionGroup has no permissionOverrides field at all.
      [{ memberIds: [USER_ID], permissions: [] }],
      ROLE_CATALOG,
    );
    expect(result.has(KEY.CONTACTS_VIEW)).toBe(true);
  });

  it('should let disabledCorePermissions win over an explicit allow override', () => {
    const result = calculateEffectivePermissions(
      { ...tenant, disabledCorePermissions: [KEY.CONTACTS_VIEW] },
      {
        id: USER_ID,
        tenants: [
          {
            tenantId: TENANT_ID,
            permissionOverrides: { [KEY.CONTACTS_VIEW]: true },
          },
        ],
      },
      [],
      ROLE_CATALOG,
    );
    expect(result.has(KEY.CONTACTS_VIEW)).toBe(false);
  });

  it('should let availablePermissions re-enable a disabled core key (union order)', () => {
    const ceiling = getTenantPermissions({
      id: TENANT_ID,
      disabledCorePermissions: [KEY.CONTACTS_VIEW],
      availablePermissions: [KEY.CONTACTS_VIEW],
    });
    // Documents that availablePermissions is applied AFTER the core filter, so
    // it wins. Worth knowing before someone uses disabledCore as a kill switch.
    expect(ceiling.has(KEY.CONTACTS_VIEW)).toBe(true);
  });
});
