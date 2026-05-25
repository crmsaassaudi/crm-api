import { Schema, Types } from 'mongoose';
import { ClsServiceManager } from 'nestjs-cls';

type TenantFilterPluginOptions = {
  field?: string;
  enforceDocumentWrites?: boolean;
  protectTenantWrites?: boolean;
};

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
  options?: TenantFilterPluginOptions,
) {
  const tenantField = options?.field || 'tenantId';
  const enforceDocumentWrites =
    options?.enforceDocumentWrites ?? !tenantField.includes('.');
  const protectTenantWrites =
    options?.protectTenantWrites ?? !tenantField.includes('.');

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
      applyTenantFilter(this, tenantField, schema);
      if (protectTenantWrites) {
        protectTenantMutation(this, tenantField);
      }
    });
  }

  schema.pre('aggregate', function () {
    applyTenantFilterToAggregate(this, tenantField, schema);
  });

  if (enforceDocumentWrites) {
    schema.pre('save', function (next) {
      try {
        enforceTenantOnDocument(this, tenantField);
        next();
      } catch (error) {
        next(error as Error);
      }
    });

    schema.pre('insertMany', function (next, docs) {
      try {
        const documents = Array.isArray(docs) ? docs : [docs];
        for (const doc of documents) {
          enforceTenantOnPlainDocument(doc, tenantField);
        }
        next();
      } catch (error) {
        next(error as Error);
      }
    });
  }
}

/**
 * Apply tenant filter to query.
 * Skips only when isPlatformQuery option is true.
 *
 * Missing tenant context throws to avoid fail-open cross-tenant reads.
 */
function applyTenantFilter(query: any, tenantField: string, schema?: Schema) {
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

  // Cast string tenantId to ObjectId when schema field type requires it.
  // Without this, string-vs-ObjectId comparison silently returns no results.
  const tenantValue = schema
    ? castTenantForQuery(schema, tenantField, activeTenantId)
    : activeTenantId;

  const currentFilter = query.getFilter?.() ?? {};

  // SECURITY: Always force the tenant filter.
  // Never trust the existing filter: remove user-supplied tenant predicates
  // recursively, then add the trusted tenant constraint from CLS.
  const sanitizedFilter = stripTenantField(currentFilter, tenantField);

  const hasOtherConditions = Object.keys(sanitizedFilter).length > 0;
  const finalQuery = hasOtherConditions
    ? { $and: [sanitizedFilter, { [tenantField]: tenantValue }] }
    : { [tenantField]: tenantValue };

  query.__tenantFiltered = true;
  query.setQuery(finalQuery);
}

function applyTenantFilterToAggregate(
  aggregate: any,
  tenantField: string,
  schema: Schema,
) {
  if (aggregate.__tenantFiltered) {
    return;
  }

  const opts = aggregate.options ?? {};
  if (opts.isPlatformQuery === true) {
    return;
  }

  if (opts.skipTenantFilter) {
    throw new Error(
      `[TenantPlugin] Refusing legacy skipTenantFilter on ${getQueryTarget(
        aggregate,
      )}. Use option({ isPlatformQuery: true }) for explicit platform-level aggregates.`,
    );
  }

  const activeTenantId = getActiveTenantId(aggregate, tenantField);
  const tenantMatchValue = castTenantForAggregate(
    schema,
    tenantField,
    activeTenantId,
  );
  const tenantMatch = { $match: { [tenantField]: tenantMatchValue } };
  const pipeline = aggregate.pipeline();
  const firstStage = pipeline[0];

  aggregate.__tenantFiltered = true;

  if (firstStage?.$geoNear) {
    firstStage.$geoNear.query = firstStage.$geoNear.query
      ? {
          $and: [
            firstStage.$geoNear.query,
            { [tenantField]: tenantMatchValue },
          ],
        }
      : { [tenantField]: tenantMatchValue };
    return;
  }

  if (firstStage?.$search || firstStage?.$vectorSearch) {
    pipeline.splice(1, 0, tenantMatch);
    return;
  }

  pipeline.unshift(tenantMatch);
}

function protectTenantMutation(query: any, tenantField: string) {
  const opts = query.getOptions?.() ?? {};
  if (opts.isPlatformQuery === true) {
    return;
  }

  const update = query.getUpdate?.();
  if (!update) {
    return;
  }

  const activeTenantId = getActiveTenantId(query, tenantField);

  if (Array.isArray(update)) {
    if (containsTenantField(update, tenantField)) {
      throwTenantMutationError(query, tenantField);
    }
    return;
  }

  if (!isPlainObject(update)) {
    return;
  }

  if (!hasAtomicUpdateOperator(update)) {
    enforceTenantOnPlainDocument(update, tenantField, activeTenantId);
    query.setUpdate(update);
    return;
  }

  for (const [operator, payload] of Object.entries(update)) {
    if (!isPlainObject(payload)) {
      continue;
    }

    if (operator === '$setOnInsert') {
      update[operator] = stripTenantField(payload, tenantField);
      continue;
    }

    if (operator === '$rename') {
      const renameTouchesTenant = Object.entries(payload).some(
        ([from, to]) => from === tenantField || to === tenantField,
      );
      if (renameTouchesTenant) {
        throwTenantMutationError(query, tenantField);
      }
      continue;
    }

    if (containsTenantField(payload, tenantField)) {
      throwTenantMutationError(query, tenantField);
    }
  }

  if (opts.upsert === true && !tenantField.includes('.')) {
    update.$setOnInsert = {
      ...(isPlainObject(update.$setOnInsert) ? update.$setOnInsert : {}),
      [tenantField]: activeTenantId,
    };
  }

  query.setUpdate(update);
}

function enforceTenantOnDocument(doc: any, tenantField: string) {
  if (doc?.$locals?.isPlatformQuery === true) {
    return;
  }

  const activeTenantId = getActiveTenantId(doc, tenantField);
  const currentValue =
    typeof doc.get === 'function' ? doc.get(tenantField) : doc[tenantField];

  if (isMissingValue(currentValue)) {
    doc.set?.(tenantField, activeTenantId);
    if (typeof doc.set !== 'function') {
      doc[tenantField] = activeTenantId;
    }
    return;
  }

  assertTenantValueMatches(currentValue, activeTenantId, doc, tenantField);
}

function enforceTenantOnPlainDocument(
  doc: any,
  tenantField: string,
  activeTenantId?: string,
) {
  const tenantId = activeTenantId ?? getActiveTenantId(doc, tenantField);
  const currentValue = doc?.[tenantField];

  if (isMissingValue(currentValue)) {
    doc[tenantField] = tenantId;
    return;
  }

  assertTenantValueMatches(currentValue, tenantId, doc, tenantField);
}

function getActiveTenantId(target: any, tenantField: string): string {
  let cls;
  try {
    cls = ClsServiceManager.getClsService();
  } catch {
    throwMissingTenantContext(
      target,
      tenantField,
      'CLS service is unavailable',
    );
  }

  const activeTenantId = cls.get('activeTenantId') || cls.get('tenantId');

  if (!activeTenantId) {
    throwMissingTenantContext(target, tenantField, 'activeTenantId is missing');
  }

  return String(activeTenantId);
}

/**
 * Cast tenantId string to the correct type for regular queries.
 * Handles both flat fields (tenantId) and nested dot-paths (tenants.tenantId)
 * by resolving the schema path type.
 */
function castTenantForQuery(
  schema: Schema,
  tenantField: string,
  activeTenantId: string,
) {
  // schema.path() works for top-level and nested dot-notation paths
  const schemaPath = schema.path(tenantField);

  if (
    schemaPath?.instance === 'ObjectId' &&
    Types.ObjectId.isValid(activeTenantId)
  ) {
    return new Types.ObjectId(activeTenantId);
  }

  // For array sub-document fields like 'tenants.tenantId',
  // schema.path() may return the parent array. Try to resolve via nested path.
  if (!schemaPath && tenantField.includes('.')) {
    const parts = tenantField.split('.');
    let currentSchema: any = schema;
    for (const part of parts) {
      const pathInfo = currentSchema?.path?.(part);
      if (!pathInfo) break;
      if (pathInfo.schema) {
        currentSchema = pathInfo.schema;
      } else if (
        pathInfo.instance === 'ObjectId' &&
        Types.ObjectId.isValid(activeTenantId)
      ) {
        return new Types.ObjectId(activeTenantId);
      } else if (pathInfo.caster?.instance === 'ObjectId') {
        return new Types.ObjectId(activeTenantId);
      } else {
        currentSchema = pathInfo;
      }
    }
  }

  return activeTenantId;
}

function castTenantForAggregate(
  schema: Schema,
  tenantField: string,
  activeTenantId: string,
) {
  const schemaPath = schema.path(tenantField);

  if (
    schemaPath?.instance === 'ObjectId' &&
    Types.ObjectId.isValid(activeTenantId)
  ) {
    return new Types.ObjectId(activeTenantId);
  }

  return activeTenantId;
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

function throwTenantMutationError(query: any, tenantField: string): never {
  throw new Error(
    `[TenantPlugin] Refusing mutation of protected tenant field "${tenantField}" on ${getQueryTarget(
      query,
    )}. Tenant context is controlled by CLS only.`,
  );
}

function hasAtomicUpdateOperator(update: Record<string, any>): boolean {
  return Object.keys(update).some((key) => key.startsWith('$'));
}

function assertTenantValueMatches(
  value: any,
  activeTenantId: string,
  target: any,
  tenantField: string,
) {
  const values = Array.isArray(value) ? value : [value];
  const hasMismatch = values.some(
    (item) => !isMissingValue(item) && String(item) !== activeTenantId,
  );

  if (hasMismatch) {
    throw new Error(
      `[TenantPlugin] Cross-tenant write detected on ${getQueryTarget(
        target,
      )} (${tenantField}).`,
    );
  }
}

function containsTenantField(
  value: any,
  tenantField: string,
  path = '',
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsTenantField(item, tenantField, path));
  }

  if (!isPlainObject(value)) {
    return false;
  }

  for (const [key, childValue] of Object.entries(value)) {
    const nextPath = key.startsWith('$') ? path : path ? `${path}.${key}` : key;

    if (nextPath === tenantField) {
      return true;
    }

    if (containsTenantField(childValue, tenantField, nextPath)) {
      return true;
    }
  }

  return false;
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

function isMissingValue(value: any): boolean {
  return value === undefined || value === null || value === '';
}
