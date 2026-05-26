import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Request } from 'express';
import { RedisService } from '../../redis/redis.service';

const BURST_CAPACITY = 60;
const SUSTAINED_PER_MINUTE = 30;
const REFILL_PER_MS = SUSTAINED_PER_MINUTE / 60_000;
const BUCKET_TTL_MS = 5 * 60_000;

const TOKEN_BUCKET_SCRIPT = `
local data = redis.call('HMGET', KEYS[1], 'tokens', 'updatedAt')
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local tokens = tonumber(data[1]) or capacity
local updatedAt = tonumber(data[2]) or now
local elapsed = math.max(0, now - updatedAt)
tokens = math.min(capacity, tokens + (elapsed * refillPerMs))
if tokens < 1 then
  redis.call('HMSET', KEYS[1], 'tokens', tokens, 'updatedAt', now)
  redis.call('PEXPIRE', KEYS[1], ttl)
  return {0, tokens}
end
tokens = tokens - 1
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'updatedAt', now)
redis.call('PEXPIRE', KEYS[1], ttl)
return {1, tokens}
`;

@Injectable()
export class ContactReportRateLimitGuard implements CanActivate {
  constructor(private readonly redisService: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const key = this.buildKey(request);

    try {
      const client = this.redisService.getClient();
      const result = (await client.eval(
        TOKEN_BUCKET_SCRIPT,
        1,
        key,
        BURST_CAPACITY,
        REFILL_PER_MS,
        Date.now(),
        BUCKET_TTL_MS,
      )) as [number, number];

      if (Number(result[0]) !== 1) {
        throw new HttpException(
          'Too many report requests. Please try again shortly.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      return true;
    }

    return true;
  }

  private buildKey(request: Request): string {
    const tenantId =
      this.headerValue(request, 'x-tenant-id') ??
      (request as any).tenantAlias ??
      (request as any).user?.tenantId ??
      'unknown-tenant';
    const userId =
      (request as any).user?.userId ??
      (request as any).user?.sub ??
      this.headerValue(request, 'x-forwarded-for') ??
      request.ip ??
      'unknown-user';
    const endpoint = `${request.method}:${request.route?.path ?? request.path}`;
    const digest = createHash('sha256')
      .update(`${tenantId}:${userId}:${endpoint}`)
      .digest('hex');

    return `reports:contact:rate:${digest}`;
  }

  private headerValue(request: Request, name: string): string | undefined {
    const value = request.headers[name];
    if (Array.isArray(value)) return value[0];
    return value;
  }
}
