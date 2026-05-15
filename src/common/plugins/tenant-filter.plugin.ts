import { Schema } from 'mongoose';
import { ClsServiceManager } from 'nestjs-cls';

/**
 * Global Mongoose Plugin - Automatic Tenant Filtering.
 *
 * Attaches to every query and automatically filters by the active tenantId
 * stored in CLS (set by TenantInterceptor or worker context helpers).
 *
 * Bypass:
 *   query.setOptions({ isPlatformQuery: true })
 *
 * Security posture:
 *   Missing CLS / tenant context fails closed. Platform-level jobs must opt in
 *   explicitly with isPlatformQuery so context loss cannot become cross-tenant
 *   data exposure.
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
    'findOneAndDelete',
    'findOneAndReplace',
    'findOneAndRemove',
    'updateOne',
    'updateMany',
    'replaceOne',
    'deleteOne',
    'deleteMany',
    'count',
    'countDocuments',
    'distinct',
  ] as const;

  for (const hook of hooks) {
    schema.pre(hook as any, function () {
      applyTenantFilter(this, tenantField);
    });
  }
}

/**
 * Apply tenant filter to query.
 * Skips only when isPlatformQuery option is true.
 *
 * Missing tenant context throws to avoid fail-open cross-tenant reads.
 */
function applyTenantFilter(query: any, tenantField: string) {
  // Guard: prevent infinite recursion.
  // setQuery() re-triggers the pre hook; bail out if we already applied the filter.
  if (query.__tenantFiltered) {
    return;
  }

  const opts = query.getOptions?.() ?? {};
  if (opts.isPlatformQuery === true) {
    return;
  }

  if (opts.skipTenantFilter) {
    throw new Error(
      `[TenantPlugin] Refusing legacy skipTenantFilter on ${getQueryTarget(query)}. ` +
        'Use setOptions({ isPlatformQuery: true }) for explicit platform-level queries.',
    );
  }

  // nestjs-cls official API for accessing CLS outside DI context.
  let cls;
  try {
    cls = ClsServiceManager.getClsService();
  } catch {
    throwMissingTenantContext(query, tenantField, 'CLS service is unavailable');
  }

  const activeTenantId = cls.get('activeTenantId') || cls.get('tenantId');

  if (!activeTenantId) {
    throwMissingTenantContext(query, tenantField, 'activeTenantId is missing');
  }

  const currentFilter = query.getFilter?.() ?? {};

  // SECURITY: Always force the tenant filter.
  // Never trust the existing filter: remove user-supplied tenant predicates
  // recursively, then add the trusted tenant constraint from CLS.
  const sanitizedFilter = stripTenantField(currentFilter, tenantField);

  const hasOtherConditions = Object.keys(sanitizedFilter).length > 0;
  const finalQuery = hasOtherConditions
    ? { $and: [sanitizedFilter, { [tenantField]: activeTenantId }] }
    : { [tenantField]: activeTenantId };

  query.__tenantFiltered = true;
  query.setQuery(finalQuery);
}

function throwMissingTenantContext(
  query: any,
  tenantField: string,
  reason: string,
): never {
  throw new Error(
    `CRITICAL: Missing activeTenantId in CLS for query on ${getQueryTarget(
      query,
    )} (${tenantField}). ${reason}. ` +
      'Possible context loss or unauthorized cross-tenant query. ' +
      'Use setOptions({ isPlatformQuery: true }) only for intentional platform-level queries.',
  );
}

function getQueryTarget(query: any): string {
  return (
    query?.model?.collection?.name ??
    query?.model?.modelName ??
    query?.schema?.options?.collection ??
    'unknown collection'
  );
}

function stripTenantField(value: any, tenantField: string, path = ''): any {
  if (Array.isArray(value)) {
    return value
      .map((item) => stripTenantField(item, tenantField, path))
      .filter((item) => !isEmptyFilter(item));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const sanitized: Record<string, any> = {};

  for (const [key, childValue] of Object.entries(value)) {
    const nextPath = key.startsWith('$') ? path : path ? `${path}.${key}` : key;

    if (nextPath === tenantField) {
      continue;
    }

    const sanitizedChild = stripTenantField(childValue, tenantField, nextPath);
    if (!isEmptyFilter(sanitizedChild)) {
      sanitized[key] = sanitizedChild;
    }
  }

  return sanitized;
}

function isPlainObject(value: any): value is Record<string, any> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isEmptyFilter(value: any): boolean {
  if (Array.isArray(value)) {
    return value.length === 0;
  }

  return isPlainObject(value) && Object.keys(value).length === 0;
}
