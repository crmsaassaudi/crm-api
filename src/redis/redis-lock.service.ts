import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';

@Injectable()
export class RedisLockService {
    private readonly logger = new Logger(RedisLockService.name);

    constructor(private readonly redisService: RedisService) { }

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
        const lockValue = Math.random().toString(36).substring(2);
        let retries = 0;

        while (retries < maxRetries) {
            // SET key value PX ttl NX
            // Returns 'OK' if set, null if not set (already exists)
            const result = await client.set(key, lockValue, 'PX', ttl, 'NX');

            if (result === 'OK') {
                try {
                    return await callback();
                } finally {
                    // Release lock only if we own it
                    // Lua script to check and delete
                    const script = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
            else
                return 0
            end
          `;
                    await client.eval(script, 1, key, lockValue);
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
