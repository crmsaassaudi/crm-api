export class CacheKeyHelper {
  static getListKey(tenantId: string, entityName: string): string {
    return `tenant:${tenantId}:${entityName}:list`;
  }

  static getDetailKey(tenantId: string, entityName: string, id: string): string {
    return `tenant:${tenantId}:${entityName}:${id}`;
  }

  static getPattern(tenantId: string, entityName: string): string {
    return `tenant:${tenantId}:${entityName}:*`;
  }
}
