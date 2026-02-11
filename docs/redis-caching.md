# Generic Redis Caching Strategy

This document details the generic Redis Caching strategy implemented for the CRM API. The system is designed to be **scalable**, **reusable**, and **automatic**, ensuring that cache invalidation is handled centrally without polluting business logic.

## 1. Architecture Overview

The caching system allows you to cache API responses and automatically invalidate them when the underlying data changes.

*   **Global Cache Module**: Uses `RedisModule` (ioredis) to store data.
*   **HttpCacheInterceptor**: A custom interceptor that generates consistent cache keys (e.g., `User:123` or `User:/api/v1/users?page=1`).
*   **Mongoose Plugin (`MongooseCachePlugin`)**: Automatically detects database changes (`save`, `findOneAndUpdate`, `findOneAndDelete`) and emits generic events (e.g., `entity.updated`).
*   **Invalidation Listener**: Listens for these events and deletes all cache keys matching the entity pattern (e.g., `User:*`).

## 2. Components

### Core Files
*   `src/common/cache/common-cache.module.ts`: The main module exporting caching services.
*   `src/common/cache/invalidation/mongoose-cache.plugin.ts`: Mongoose plugin for auto-events.
*   `src/common/cache/interceptors/http-cache.interceptor.ts`: Interceptor for Controllers.
*   `src/common/cache/decorators/cache-entity.decorator.ts`: Decorator to specify Entity Name.

## 3. How to Use

### Step 1: Enable Caching in Controller

To cache an endpoint, apply the `@UseInterceptors(HttpCacheInterceptor)`, `@CacheEntity`, and `@CacheTTL` decorators.

```typescript
// src/users/users.controller.ts

import { UseInterceptors } from '@nestjs/common';
import { CacheTTL } from '@nestjs/cache-manager';
import { HttpCacheInterceptor } from '../common/cache/interceptors/http-cache.interceptor';
import { CacheEntity } from '../common/cache/decorators/cache-entity.decorator';

@ApiTags('Users')
@Controller({ path: 'users', version: '1' })
@UseInterceptors(HttpCacheInterceptor) // 1. Apply Interceptor
@CacheEntity('User')                   // 2. Define Entity Name (Matches Generic Key)
export class UsersController {
  
  @Get()
  @CacheTTL(60) // 3. Cache for 60 seconds
  findAll() { ... }

  @Get(':id')
  @CacheTTL(60)
  findOne(@Param('id') id: string) { ... }
}
```

*   **@CacheEntity('User')**: Tells the system to prefix keys with `User:`. This is critical for invalidation.
*   **@CacheTTL(60)**: Sets the Time-To-Live in seconds.
*   **Keys Generated**: 
    *   List: `User:/api/v1/users?page=1...`
    *   Detail: `User:123` (if `id` param exists)

### Step 2: Enable Auto-Invalidation in Schema

To automatically clear the cache when data changes, register the `MongooseCachePlugin` in your module (Persistence Layer).

**Note:** You must use `forFeatureAsync` to inject `EventEmitter2`.

```typescript
// src/users/infrastructure/persistence/document/document-persistence.module.ts

import { MongooseCachePlugin } from '../../../../common/cache/invalidation/mongoose-cache.plugin';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Module({
  imports: [
    MongooseModule.forFeatureAsync([
      {
        name: UserSchemaClass.name,
        useFactory: (eventEmitter: EventEmitter2) => {
          const schema = UserSchema;
          // Apply Plugin
          schema.plugin(MongooseCachePlugin, {
            eventEmitter,
            entityName: 'User', // Must match @CacheEntity name
          });
          return schema;
        },
        inject: [EventEmitter2],
      },
    ]),
  ],
  ...
})
export class DocumentUserPersistenceModule {}
```

That's it! 

*   When you call `userModel.save()`, `update()`, or `delete()`, the plugin emits an event.
*   The `CacheInvalidationListener` receives the event and deletes **ALL** keys starting with `User:*`.

## 4. Advanced Usage

### Manual Invalidation
If you need to invalidate cache manually (e.g., complex business logic not using Mongoose directly):

```typescript
import { CacheInvalidationService } from 'src/common/cache/cache-invalidation.service';
import { CacheKeyHelper } from 'src/common/cache/cache-key.helper';

export class SomeService {
  constructor(private invalidationService: CacheInvalidationService) {}

  async someMethod() {
    // ... logic ...
    const pattern = CacheKeyHelper.getPattern('User'); // Returns "User:*"
    await this.invalidationService.clearCacheByPattern(pattern);
  }
}
```

## 5. Troubleshooting
*   **Cache not working?** Ensure Redis is running and `RedisModule` is connected.
*   **Cache not clearing?** 
    *   Check if `entityName` in Schema Plugin matches `@CacheEntity` in Controller.
    *   Ensure you are using Mongoose methods that trigger hooks (`save`, `findOneAndUpdate`, `findOneAndDelete`). efficient updates like `updateMany` might **NOT** trigger hooks unless explicitly configured.
