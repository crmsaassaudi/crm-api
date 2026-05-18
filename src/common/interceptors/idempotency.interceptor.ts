import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
} from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { ConflictException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { Observable, of, throwError } from 'rxjs';
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
const ERROR_TTL_SECONDS = readPositiveNumberEnv(
  'IDEMPOTENCY_ERROR_TTL_SECONDS',
  2 * 60,
);

type IdempotencyCacheEnvelope =
  | {
      __idempotencyCache: true;
      type: 'success';
      body: unknown;
    }
  | {
      __idempotencyCache: true;
      type: 'error';
      statusCode: number;
      body: unknown;
    };

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
    const subjectScope = this.resolveSubjectScope(request);
    const namespacedKey = `${tenantPrefix}idmp:${subjectScope}:${key}`;
    const lockKey = `lock:${namespacedKey}`;
    const lockValue = randomUUID();

    // Atomic check-and-lock: single Lua round-trip replaces 3 separate Redis ops.
    // Returns: cached JSON string | 'LOCKED' | null (lock acquired, proceed).
    const checkAndLockScript = `
      local cached = redis.call('get', KEYS[1])
      if cached ~= false then return cached end
      if redis.call('set', KEYS[2], ARGV[1], 'EX', ARGV[2], 'NX') == false then
        return 'LOCKED'
      end
      return nil
    `;
    const scriptResult = await client.eval(
      checkAndLockScript,
      2,
      namespacedKey,
      lockKey,
      lockValue,
      String(LOCK_TTL_SECONDS),
    );

    if (scriptResult !== null) {
      if (scriptResult === 'LOCKED') {
        throw new ConflictException('Request is being processed. Please retry.');
      }
      // Cached result found — replay it
      try {
        const parsed: unknown =
          typeof scriptResult === 'string' ? JSON.parse(scriptResult) : scriptResult;
        return this.replayCached(parsed);
      } catch {
        return this.replayCached(scriptResult);
      }
    }

    return next.handle().pipe(
      mergeMap(async (response) => {
        await this.redisService.set(
          namespacedKey,
          {
            __idempotencyCache: true,
            type: 'success',
            body: response,
          } satisfies IdempotencyCacheEnvelope,
          RESPONSE_TTL_SECONDS,
        );
        await this.releaseLock(client, lockKey, lockValue);
        return response;
      }),
      // Handle errors - make sure to release lock if processing fails
      catchError(async (err) => {
        const cachedError = this.toCacheableError(err);
        if (cachedError) {
          await this.redisService.set(
            namespacedKey,
            cachedError,
            ERROR_TTL_SECONDS,
          );
        }
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

  private replayCached(cached: unknown): Observable<any> {
    if (this.isEnvelope(cached)) {
      if (cached.type === 'error') {
        return throwError(
          () => new HttpException(cached.body as any, cached.statusCode),
        );
      }

      return of(cached.body);
    }

    return of(cached);
  }

  private isEnvelope(value: unknown): value is IdempotencyCacheEnvelope {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as any).__idempotencyCache === true &&
      ((value as any).type === 'success' || (value as any).type === 'error')
    );
  }

  private toCacheableError(error: any): IdempotencyCacheEnvelope | null {
    const statusCode =
      typeof error?.getStatus === 'function'
        ? error.getStatus()
        : Number(error?.status ?? error?.statusCode);

    if (
      !Number.isInteger(statusCode) ||
      statusCode < 400 ||
      statusCode >= 500 ||
      statusCode === 409
    ) {
      return null;
    }

    const body =
      typeof error?.getResponse === 'function'
        ? error.getResponse()
        : (error?.response ?? {
            statusCode,
            message: error?.message ?? 'Request failed',
          });

    return {
      __idempotencyCache: true,
      type: 'error',
      statusCode,
      body,
    };
  }

  private resolveSubjectScope(request: any): string {
    let userId: unknown;
    try {
      const cls = ClsServiceManager.getClsService();
      userId = cls.get('userId');
    } catch {
      /* CLS unavailable */
    }

    userId =
      userId ??
      request?.user?.userId ??
      request?.user?.id ??
      request?.user?.sub;

    if (userId) {
      return `user:${String(userId)}`;
    }

    const fingerprint = [
      this.extractHeader(request, 'x-forwarded-for') ?? request?.ip ?? '',
      this.extractHeader(request, 'user-agent') ?? '',
    ].join('|');

    return `anonymous:${createHash('sha256')
      .update(fingerprint)
      .digest('hex')
      .slice(0, 32)}`;
  }

  private extractHeader(request: any, name: string): string | undefined {
    const value = request?.headers?.[name];
    if (Array.isArray(value)) return value[0];
    return value;
  }
}
