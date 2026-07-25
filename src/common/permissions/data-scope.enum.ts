/**
 * DataScope — how wide a principal's read scope is *within* one tenant.
 *
 * This is the single axis that replaces the four separate scope words the spec
 * used to carry (Self / Team / Department / Branch / Organization). Department
 * and Branch were never two different mechanisms: they are two *depths* of one
 * org-unit tree, so they collapse into ORG_UNIT / ORG_UNIT_SUBTREE. And
 * "Organization" was always the tenant itself, which the tenant filter already
 * enforces on every query — so it is TENANT here, not a separate boundary.
 *
 * Values are ordered by breadth, narrowest first. `maxScope()` relies on that
 * order, so new members must be inserted at the right position rather than
 * appended.
 *
 * The tenant boundary is NOT on this axis. No scope value can cross it:
 * `tenantFilterPlugin` is applied below this layer and is not negotiable from
 * here. TENANT is therefore the widest scope that exists for a tenant member;
 * seeing across tenants requires `platformRole = SUPER_ADMIN`, which is a
 * different mechanism entirely.
 */
export enum DataScope {
  /** Only records the principal owns. */
  SELF = 'self',

  /**
   * Own records plus those of everyone below them in the `reportsToId` chain.
   * A *personal* relation — it follows the individual, not their unit, so a
   * direct report in another org unit is still included.
   */
  SUBORDINATES = 'subordinates',

  /**
   * Own records plus every record belonging to the principal's own org unit.
   * This is what "Department scope" means when the unit is a department, and
   * what "Branch scope" means when it is a branch. Same mechanism.
   */
  ORG_UNIT = 'org_unit',

  /**
   * The principal's org unit and all units beneath it. A branch director over
   * several departments; a regional head over several branches.
   */
  ORG_UNIT_SUBTREE = 'org_unit_subtree',

  /** Every record in the tenant. The old "Organization" scope. */
  TENANT = 'tenant',
}

/** Breadth order, narrowest first. Index in this array IS the breadth rank. */
export const DATA_SCOPE_ORDER: readonly DataScope[] = [
  DataScope.SELF,
  DataScope.SUBORDINATES,
  DataScope.ORG_UNIT,
  DataScope.ORG_UNIT_SUBTREE,
  DataScope.TENANT,
] as const;

export const isDataScope = (value: unknown): value is DataScope =>
  typeof value === 'string' &&
  (DATA_SCOPE_ORDER as readonly string[]).includes(value);

/**
 * The widest scope among the given values — a principal holding several roles
 * gets the broadest scope any of them grants.
 *
 * Union, not intersection, deliberately. Scope is *additive visibility*, the
 * same way `permissions` is additive: holding "Sales Rep" (SELF) and "Sales
 * Manager" (ORG_UNIT) must behave like the manager, otherwise granting an
 * extra role would silently shrink what someone can see. Restriction is
 * expressed with an explicit ABAC deny policy, never by narrowing scope.
 *
 * Unknown / malformed values are ignored rather than defaulting to a wide
 * scope: a typo'd scope string must not become tenant-wide read access.
 * With no valid input the result is SELF — the narrowest, i.e. fail-closed.
 */
export function maxScope(values: Iterable<unknown>): DataScope {
  let rank = 0;
  for (const value of values) {
    if (!isDataScope(value)) continue;
    const candidate = DATA_SCOPE_ORDER.indexOf(value);
    if (candidate > rank) rank = candidate;
  }
  return DATA_SCOPE_ORDER[rank];
}

/** True when `scope` is at least as wide as `minimum`. */
export function scopeAtLeast(scope: DataScope, minimum: DataScope): boolean {
  return DATA_SCOPE_ORDER.indexOf(scope) >= DATA_SCOPE_ORDER.indexOf(minimum);
}
