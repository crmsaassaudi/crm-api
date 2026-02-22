import { Schema } from 'mongoose';
import { ClsServiceManager } from 'nestjs-cls';

/**
 * Global Mongoose Plugin — Automatic Tenant Filtering
 *
 * Attaches to every query and automatically filters by the active tenantId
 * stored in CLS (set by TenantInterceptor or CLS middleware).
 *
 * Bypass:
 *   query.setOptions({ skipTenantFilter: true })
 *   — or —
 *   Model.find().setOptions({ skipTenantFilter: true })
 */
export function tenantFilterPlugin(
  schema: Schema,
  options?: { field?: string },
) {
  const tenantField = options?.field || 'tenants.tenant';

  const hooks = [
    'find',
    'findOne',
    'findOneAndUpdate',
    'updateMany',
    'deleteMany',
    'countDocuments',
  ] as const;

  for (const hook of hooks) {
    schema.pre(hook, function () {
      applyTenantFilter(this, tenantField);
    });
  }
}

/**
 * Apply tenant filter to query if activeTenantId exists in CLS.
 * Skips when:
 *  - CLS is unavailable (startup, seeder)
 *  - No tenantId in CLS (platform-level / anonymous request)
 *  - Query already has explicit tenant filter
 *  - skipTenantFilter option is true (admin / cross-tenant queries)
 */
function applyTenantFilter(query: any, tenantField: string) {
  // nestjs-cls official API for accessing CLS outside DI context
  let cls;
  try {
    cls = ClsServiceManager.getClsService();
  } catch {
    return; // CLS not yet initialized (e.g., during app bootstrap / seeds)
  }

  // Check for bypass flag
  const opts = query.getOptions?.() ?? {};
  if (opts.skipTenantFilter) {
    return;
  }

  const activeTenantId = cls.get('activeTenantId') || cls.get('tenantId');

  // null / undefined = no tenant context → skip (platform-level query)
  if (!activeTenantId) {
    return;
  }

  const currentFilter = query.getFilter();

  // SECURITY: Always force the tenant filter using $and.
  // Never trust the existing filter — it may contain attacker-injected values.
  // Remove any user-supplied tenant field to prevent bypass.
  const sanitizedFilter = { ...currentFilter };
  delete sanitizedFilter[tenantField];

  query.setQuery({
    $and: [sanitizedFilter, { [tenantField]: activeTenantId }],
  });
}
