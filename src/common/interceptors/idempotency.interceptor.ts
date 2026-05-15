import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Observable, of } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { RedisService } from '../../redis/redis.service';
import type Redis from 'ioredis';

const LOCK_TTL_SECONDS = readPositiveNumberEnv(
  'IDEMPOTENCY_LOCK_TTL_SECONDS',
  60,
);
const RESPONSE_TTL_SECONDS = readPositiveNumberEnv(
  'IDEMPOTENCY_RESPONSE_TTL_SECONDS',
  2 * 60 * 60,
);
function readPositiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly redisService: RedisService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const rawIdempotencyKey = request.headers['x-idempotency-key'];
    const idempotencyKey = Array.isArray(rawIdempotencyKey)
      ? rawIdempotencyKey[0]
      : rawIdempotencyKey;

    if (!idempotencyKey) {
      return next.handle();
    }

    const client = this.redisService.getClient(); // Get ioredis client
    const key = String(idempotencyKey).trim();

    if (!key) {
      return next.handle();
    }

    let tenantPrefix = '';
    try {
      const cls = ClsServiceManager.getClsService();
      const tid = cls.get('tenantId');
      if (tid) tenantPrefix = `t:${tid}:`;
    } catch {
      /* CLS unavailable */
    }
    const namespacedKey = `${tenantPrefix}idmp:${key}`;
    const lockKey = `lock:${namespacedKey}`;
    const lockValue = randomUUID();

    const existingResponse = await this.redisService.get(namespacedKey);
    if (existingResponse !== undefined) {
      return of(existingResponse);
    }

    // 1. Try to acquire lock
    // SET key value NX EX seconds
    const acquired = await client.set(
      lockKey,
      lockValue,
      'EX',
      LOCK_TTL_SECONDS,
      'NX',
    );

    if (!acquired) {
      const cachedResponse = await this.redisService.get(namespacedKey);
      if (cachedResponse !== undefined) {
        return of(cachedResponse);
      }
      throw new ConflictException('Request is being processed. Please retry.');
    }

    // 3. If lock acquired, check cache one last time (double-check optimization)
    const cachedResponse = await this.redisService.get(namespacedKey);
    if (cachedResponse !== undefined) {
      await this.releaseLock(client, lockKey, lockValue);
      return of(cachedResponse);
    }

    return next.handle().pipe(
      mergeMap(async (response) => {
        await this.redisService.set(
          namespacedKey,
          response,
          RESPONSE_TTL_SECONDS,
        );
        await this.releaseLock(client, lockKey, lockValue);
        return response;
      }),
      // Handle errors - make sure to release lock if processing fails
      catchError(async (err) => {
        await this.releaseLock(client, lockKey, lockValue);
        throw err;
      }),
    );
  }

  private async releaseLock(
    client: Redis,
    key: string,
    value: string,
  ): Promise<void> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      end
      return 0
    `;
    await client.eval(script, 1, key, value);
  }
}
