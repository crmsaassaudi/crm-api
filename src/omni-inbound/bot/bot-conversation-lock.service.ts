import { Inject, Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import type Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';

@Injectable()
export class BotConversationLockService {
  private readonly logger = new Logger(BotConversationLockService.name);
  private readonly releaseScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    end
    return 0
  `;

  constructor(@Inject(IOREDIS_CLIENT) private readonly redis: Redis) {}

  async tryAcquire(key: string, ttlMs: number): Promise<string | null> {
    const token = ulid();
    const acquired = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    return acquired === 'OK' ? token : null;
  }

  async release(key: string, token: string): Promise<void> {
    try {
      await this.redis.eval(this.releaseScript, 1, key, token);
    } catch (error) {
      this.logger.warn(
        `Failed to release bot conversation lock ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
