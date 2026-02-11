import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service'; // Adjust path if needed

@Injectable()
export class CacheInvalidationService {
    private readonly logger = new Logger(CacheInvalidationService.name);

    constructor(private readonly redisService: RedisService) { }

    async clearCacheByPattern(pattern: string): Promise<void> {
        const client = this.redisService.getClient();
        const stream = client.scanStream({
            match: pattern,
            count: 100,
        });

        const keysToDelete: string[] = [];

        stream.on('data', (keys) => {
            keysToDelete.push(...keys);
        });

        stream.on('end', async () => {
            if (keysToDelete.length > 0) {
                await client.del(keysToDelete);
                this.logger.log(`Cleared ${keysToDelete.length} keys matching pattern: ${pattern}`);
            }
        });

        stream.on('error', (err) => {
            this.logger.error(`Error scanning keys for pattern ${pattern}: ${err.message}`, err.stack);
        });
    }
}
