import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { RedisService } from '../../redis/redis.service';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly redisService: RedisService) { }

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const idempotencyKey = request.headers['x-idempotency-key'];

    if (!idempotencyKey) {
      return next.handle();
    }

    const client = this.redisService.getClient(); // Get ioredis client
    const key = idempotencyKey as string;
    const lockKey = `lock:${key}`;

    // 1. Try to acquire lock
    // SET key value NX EX seconds
    const acquired = await client.set(lockKey, 'processing', 'EX', 60, 'NX');

    if (!acquired) {
      // 2. If lock exists, check if result is already cached
      const cachedResponse = await this.redisService.get(key);
      if (cachedResponse) {
        return of(cachedResponse);
      }
      // If lock exists but no cache, it means it's still processing
      throw new ConflictException('Request is being processed. Please wait.');
    }

    // 3. If lock acquired, check cache one last time (double-check optimization)
    const cachedResponse = await this.redisService.get(key);
    if (cachedResponse) {
      await client.del(lockKey); // Release lock if we somehow got here
      return of(cachedResponse);
    }

    return next.handle().pipe(
      tap(async (response) => {
        // Cache the response with a TTL of 24 hours (86400 seconds)
        await this.redisService.set(key, response, 86400);
        // Release lock
        await client.del(lockKey);
      }),
      // Handle errors - make sure to release lock if processing fails
      catchError(async (err) => {
        await client.del(lockKey);
        throw err;
      }),
    );
  }
}
