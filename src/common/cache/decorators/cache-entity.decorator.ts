import { SetMetadata } from '@nestjs/common';

export const CACHE_ENTITY_KEY = 'cache_entity';
export const CacheEntity = (entityName: string) =>
  SetMetadata(CACHE_ENTITY_KEY, entityName);
