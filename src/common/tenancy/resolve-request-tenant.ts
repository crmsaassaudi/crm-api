import { UnprocessableEntityException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { getTenantId } from '../cls/cls-context.helper';

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/**
 * Resolve the active tenant for a request-scoped controller.
 *
 * TenantInterceptor resolves the tenant (alias / Keycloak org id / ObjectId →
 * ObjectId) and stores the result in CLS ONLY. `req.tenantId` is never set, and
 * `req.user.tenantId` is just one of the raw *hints* fed to that resolution — it
 * can be an alias, so it must not be used as a tenant id.
 *
 * Reading it from the request instead of CLS is how the authz controllers ended
 * up querying `{ tenantId: undefined }`: silently empty lists on GET, and a
 * "Path `tenantId` is required" ValidationError → 500 on POST.
 */
export function resolveRequestTenantId(cls: ClsService, req?: any): string {
  const fromCls = getTenantId(cls);
  if (fromCls) return String(fromCls);

  // Last-resort fallback, and only when the hint is already an ObjectId — an
  // alias here would scope the query to a tenant that does not exist.
  const hint = req?.tenantId ?? req?.user?.tenantId;
  if (hint && OBJECT_ID.test(String(hint))) return String(hint);

  throw new UnprocessableEntityException('Tenant context missing');
}
