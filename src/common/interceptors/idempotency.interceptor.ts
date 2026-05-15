import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { ConflictException } from '@nestjs/common';
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
const WAIT_TIMEOUT_MS = readPositiveNumberEnv(
  'IDEMPOTENCY_WAIT_TIMEOUT_MS',
  5000,
);
const WAIT_POLL_INTERVAL_MS = readPositiveNumberEnv(
  'IDEMPOTENCY_WAIT_POLL_INTERVAL_MS',
  100,
);

function readPositiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type WaitResult =
  | { status: 'cached'; response: any }
  | { status: 'retryable' }
  | { status: 'processing' };

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

    const existingResponse = await this.redisService.get(namespacedKey);
    if (existingResponse !== undefined) {
      return of(existingResponse);
    }

    // 1. Try to acquire lock
    // SET key value NX EX seconds
    let acquired = await client.set(
      lockKey,
      'processing',
      'EX',
      LOCK_TTL_SECONDS,
      'NX',
    );

    if (!acquired) {
      const waitResult = await this.waitForCachedResponse(
        client,
        namespacedKey,
        lockKey,
      );

      if (waitResult.status === 'cached') {
        return of(waitResult.response);
      }

      if (waitResult.status === 'retryable') {
        acquired = await client.set(
          lockKey,
          'processing',
          'EX',
          LOCK_TTL_SECONDS,
          'NX',
        );
      }

      if (!acquired) {
        throw new ConflictException('Request is being processed. Please wait.');
      }

      const cachedResponse = await this.redisService.get(namespacedKey);
      if (cachedResponse !== undefined) {
        await client.del(lockKey);
        return of(cachedResponse);
      }
    }

    // 3. If lock acquired, check cache one last time (double-check optimization)
    const cachedResponse = await this.redisService.get(namespacedKey);
    if (cachedResponse !== undefined) {
      await client.del(lockKey); // Release lock if we somehow got here
      return of(cachedResponse);
    }

    return next.handle().pipe(
      mergeMap(async (response) => {
        await this.redisService.set(
          namespacedKey,
          response,
          RESPONSE_TTL_SECONDS,
        );
        await client.del(lockKey);
        return response;
      }),
      // Handle errors - make sure to release lock if processing fails
      catchError(async (err) => {
        await client.del(lockKey);
        throw err;
      }),
    );
  }

  private async waitForCachedResponse(
    client: Redis,
    responseKey: string,
    lockKey: string,
  ): Promise<WaitResult> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await this.sleep(WAIT_POLL_INTERVAL_MS);

      const cachedResponse = await this.redisService.get(responseKey);
      if (cachedResponse !== undefined) {
        return { status: 'cached', response: cachedResponse };
      }

      const lockExists = await client.exists(lockKey);
      if (!lockExists) {
        return { status: 'retryable' };
      }
    }

    return { status: 'processing' };
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
