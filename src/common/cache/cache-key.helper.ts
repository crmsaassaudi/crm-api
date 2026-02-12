export class CacheKeyHelper {
  static getListKey(entityName: string): string {
    return `${entityName}:list`;
  }

  static getDetailKey(entityName: string, id: string): string {
    return `${entityName}:${id}`;
  }

  static getPattern(entityName: string): string {
    return `${entityName}:*`;
  }
}
