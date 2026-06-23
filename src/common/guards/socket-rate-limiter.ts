import { Injectable, Inject, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';

/**
 * SocketRateLimiter — Redis-based sliding window rate limiter for WebSocket events.
 *
 * T-031: Prevent visitor spam by limiting event frequency per socket.
 *
 * Design:
 * - Uses Redis INCR + EXPIRE for a simple fixed-window counter
 * - Key pattern: `ratelimit:ws:{socketId}:{eventName}`
 * - Configurable limit and window per event type
 * - Returns violation count so callers can disconnect repeat offenders
 */
@Injectable()
export class SocketRateLimiter {
  private readonly logger = new Logger(SocketRateLimiter.name);

  /** Per-event rate limit configuration */
  private static readonly LIMITS: Record<
    string,
    { max: number; windowSec: number }
  > = {
    'visitor:message': { max: 10, windowSec: 10 }, // 10 messages per 10s
    'visitor:upload': { max: 3, windowSec: 30 }, // 3 uploads per 30s
    'visitor:typing': { max: 20, windowSec: 10 }, // 20 typing events per 10s
    'visitor:reaction': { max: 10, windowSec: 10 }, // 10 reactions per 10s
    'visitor:ack': { max: 50, windowSec: 10 }, // Delivery acks — generous
    'visitor:read': { max: 20, windowSec: 10 }, // Read receipts
    default: { max: 15, windowSec: 10 },
  };

  constructor(@Inject(IOREDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Check if a socket event is within rate limits.
   *
   * @returns `true` if the event is allowed, `false` if rate limited.
   */
  async isAllowed(socketId: string, eventName: string): Promise<boolean> {
    const config =
      SocketRateLimiter.LIMITS[eventName] ?? SocketRateLimiter.LIMITS.default;
    const key = `ratelimit:ws:${socketId}:${eventName}`;

    try {
      const count = await this.redis.incr(key);

      // Set TTL only on the first increment (when count === 1)
      if (count === 1) {
        await this.redis.expire(key, config.windowSec);
      }

      if (count > config.max) {
        this.logger.warn(
          `[RateLimit] Socket ${socketId} exceeded limit for ${eventName}: ${count}/${config.max} in ${config.windowSec}s`,
        );
        return false;
      }

      return true;
    } catch (err: any) {
      // Redis failure → fail open (allow the event) to avoid blocking legitimate users
      this.logger.error(
        `[RateLimit] Redis error for ${socketId}:${eventName}: ${err?.message}`,
      );
      return true;
    }
  }

  /**
   * Track consecutive rate limit violations for a socket.
   * Returns the violation count so the caller can decide to disconnect.
   */
  async trackViolation(socketId: string): Promise<number> {
    const key = `ratelimit:violations:${socketId}`;
    try {
      const count = await this.redis.incr(key);
      if (count === 1) {
        // Auto-expire after 60 seconds so a brief burst is forgiven
        await this.redis.expire(key, 60);
      }
      return count;
    } catch {
      return 0;
    }
  }

  /**
   * Clean up rate limit keys when socket disconnects.
   */
  async cleanup(socketId: string): Promise<void> {
    try {
      const keys = await this.redis.keys(`ratelimit:ws:${socketId}:*`);
      keys.push(`ratelimit:violations:${socketId}`);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch {
      // Non-critical — keys will TTL out naturally
    }
  }
}
