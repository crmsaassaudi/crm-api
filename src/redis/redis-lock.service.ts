import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from './redis.service';

@Injectable()
export class RedisLockService {
  private readonly logger = new Logger(RedisLockService.name);
  private readonly releaseScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    end
    return 0
  `;
  private readonly extendScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("pexpire", KEYS[1], ARGV[2])
    end
    return 0
  `;

  constructor(private readonly redisService: RedisService) {}

  /**
   * Acquires a lock and executes the callback.
   * If the lock is busy, it waits/retries until timeout or success.
   */
  async acquire<T>(
    key: string,
    ttl: number,
    callback: () => Promise<T>,
    retryDelay = 100,
    maxRetries = 50,
  ): Promise<T> {
    const client = this.redisService.getClient();
    const lockValue = randomUUID();
    let retries = 0;

    while (retries < maxRetries) {
      // SET key value PX ttl NX
      // Returns 'OK' if set, null if not set (already exists)
      const result = await client.set(key, lockValue, 'PX', ttl, 'NX');

      if (result === 'OK') {
        let lockLost = false;
        let active = true;
        const heartbeatMs = Math.max(100, Math.floor(ttl / 3));
        const heartbeat = setInterval(() => {
          void client
            .eval(this.extendScript, 1, key, lockValue, ttl.toString())
            .then((extended) => {
              if (!active) return;
              if (extended !== 1) {
                lockLost = true;
                this.logger.error(`Lost Redis lock ownership for key ${key}`);
              }
            })
            .catch((err) => {
              if (!active) return;
              lockLost = true;
              this.logger.error(
                `Failed to extend Redis lock ${key}: ${err.message}`,
              );
            });
        }, heartbeatMs);

        try {
          const value = await callback();
          if (lockLost) {
            this.logger.error(
              `Callback completed after Redis lock ${key} may have expired`,
            );
          }
          return value;
        } finally {
          active = false;
          clearInterval(heartbeat);
          await client.eval(this.releaseScript, 1, key, lockValue);
        }
      }

      retries++;
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }

    throw new InternalServerErrorException(
      `Could not acquire lock for key ${key} after ${maxRetries} retries`,
    );
  }
}
