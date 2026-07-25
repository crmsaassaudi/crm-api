/**
 * HTTP response cache keys.
 *
 * Shape: `tenant:<tenantId>:user:<userId>:<Entity>:<id|url>`
 *
 * The principal is part of the key by necessity, not convenience (C-03):
 * response bodies are shaped per-user by data visibility (`visibleOwnerIds`)
 * and by field masking, so a tenant-only key serves one user's result set to
 * another. Invalidation therefore has to wildcard across users — when an entity
 * changes it affects every principal who may have cached a view of it.
 *
 * Keys are produced by HttpCacheInterceptor.trackBy(); this helper exists for
 * the invalidation side, so both must be changed together.
 */
export class CacheKeyHelper {
  static getDetailKey(
    tenantId: string,
    userId: string,
    entityName: string,
    id: string,
  ): string {
    return `tenant:${tenantId}:user:${userId}:${entityName}:${id}`;
  }

  /** Every cached response for one entity, across all users of a tenant. */
  static getPattern(tenantId: string, entityName: string): string {
    return `tenant:${tenantId}:user:*:${entityName}:*`;
  }

  /** Every cached response for one user — use when their permissions change. */
  static getUserPattern(tenantId: string, userId: string): string {
    return `tenant:${tenantId}:user:${userId}:*`;
  }

  /** Every cached response in a tenant — use on tenant-wide permission changes. */
  static getTenantPattern(tenantId: string): string {
    return `tenant:${tenantId}:user:*`;
  }
}
