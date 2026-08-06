import { ClsService } from 'nestjs-cls';

/**
 * The owner / org-unit / ABAC predicate a read must be intersected with, derived
 * from the request context.
 *
 * The single definition of the rule, so reads that cannot go through a
 * repository enforce the same predicate: ContactTimelineService fans in across
 * deals, tickets, tasks, notes and conversations on the raw connection, and a
 * second copy there would drift from the one repositories apply.
 *
 * Returns `null` when no restriction applies (admin bypass, or visibility not
 * evaluated for this request). Callers must treat `null` as "no extra clause",
 * never as "deny".
 */
export function buildVisibilityClauses(
  cls: ClsService,
  moduleKey: string | null,
  /**
   * False for collections that are not owned records (users, settings): the
   * owner/org-unit axis is skipped while an ABAC deny for the module still
   * applies, which is how the repository layer has always behaved.
   */
  ownerAxis = true,
): Record<string, unknown>[] | null {
  const clauses: Record<string, unknown>[] = [];

  // `visibleOwnerIds` has three states:
  //   undefined → not evaluated, apply no filter
  //   null      → admin/owner bypass, see everything
  //   string[]  → restrict to these owners
  const { visibleOwnerIds, visibleOrgUnitIds } = resolveVisibility(
    cls,
    moduleKey,
  );

  if (ownerAxis && Array.isArray(visibleOwnerIds)) {
    // Unowned records stay hidden from a scoped user unless the tenant opts in.
    const ownerClauses: Record<string, unknown>[] = [
      { ownerId: { $in: visibleOwnerIds } },
    ];
    if (cls.get('includeUnownedInScope') === true) {
      ownerClauses.push({ ownerId: null });
    }
    // Unioned with the owner axis, never intersected — a wider scope must never
    // return fewer rows. An empty array adds no clause: as `$in: []` it would
    // match nothing and erase the owner clause it was meant to widen.
    if (Array.isArray(visibleOrgUnitIds) && visibleOrgUnitIds.length > 0) {
      ownerClauses.push({ orgUnitId: { $in: visibleOrgUnitIds } });
    }
    clauses.push({ $or: ownerClauses });
  }

  const abac = cls.get<{
    resource?: string;
    filter?: Record<string, unknown> | null;
  }>('abacResourceFilter');
  if (moduleKey && abac?.filter && matchesResource(moduleKey, abac.resource)) {
    clauses.push(abac.filter);
  }

  return clauses.length > 0 ? clauses : null;
}

function resolveVisibility(
  cls: ClsService,
  moduleKey: string | null,
): { visibleOwnerIds: unknown; visibleOrgUnitIds: unknown } {
  if (moduleKey) {
    const byModule = cls.get('dataVisibilityByModule') as
      | Record<
          string,
          { ownerIds: string[] | null; orgUnitIds: string[] | null }
        >
      | undefined;
    const override = byModule?.[moduleKey];
    if (override) {
      return {
        visibleOwnerIds: override.ownerIds,
        visibleOrgUnitIds: override.orgUnitIds,
      };
    }
  }
  return {
    visibleOwnerIds: cls.get('visibleOwnerIds'),
    visibleOrgUnitIds: cls.get('visibleOrgUnitIds'),
  };
}

function matchesResource(moduleKey: string, resource?: string): boolean {
  if (!resource) return false;
  const moduleName = moduleKey.toLowerCase();
  const resourceName = resource.toLowerCase();
  return (
    resourceName === moduleName ||
    resourceName === `${moduleName}s` ||
    (moduleName.endsWith('y') &&
      resourceName === `${moduleName.slice(0, -1)}ies`)
  );
}
