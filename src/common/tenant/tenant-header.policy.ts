/**
 * The single decision point for whether an `x-tenant-id` request header may be
 * trusted as a tenant hint (finding H-09).
 *
 * Previously each call site made this choice for itself with
 * `process.env.NODE_ENV !== 'production'`. That is the wrong control for two
 * reasons:
 *
 *   1. Staging / UAT / load-test environments run with NODE_ENV != 'production'
 *      while holding production-shaped data, so the header was a live
 *      cross-tenant switch there.
 *   2. A single mis-set env var silently converts production into that state,
 *      and nothing in the code makes the dependency visible.
 *
 * The header is now opt-in and off by default in EVERY environment. A developer
 * who needs it sets `ALLOW_TENANT_HEADER=1` in their local `.env`; it must never
 * be set on a deployed environment, and it is refused outright when
 * `NODE_ENV=production` so it cannot be enabled there by accident.
 *
 * The legitimate tenant sources remain: subdomain alias, session, and JWT claim.
 */
export const TENANT_HEADER = 'x-tenant-id';

export function isTenantHeaderTrusted(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.ALLOW_TENANT_HEADER === '1';
}

/**
 * Read the tenant hint header, but only when this environment trusts it.
 * Returns undefined otherwise — callers must fall through to a real source.
 */
export function readTrustedTenantHeader(request: any): string | undefined {
  if (!isTenantHeaderTrusted()) return undefined;

  const value = request?.headers?.[TENANT_HEADER];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' && value ? value : undefined;
}
