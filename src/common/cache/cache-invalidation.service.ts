import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service'; // Adjust path if needed

@Injectable()
export class CacheInvalidationService {
  private readonly logger = new Logger(CacheInvalidationService.name);

  constructor(private readonly redisService: RedisService) {}

  clearCacheByPattern(pattern: string): Promise<void> {
    const client = this.redisService.getClient();
    const stream = client.scanStream({
      match: pattern,
      count: 100,
    });

    const keysToDelete: string[] = [];

    stream.on('data', (keys) => {
      keysToDelete.push(...keys);
    });

    return new Promise<void>((resolve, reject) => {
      stream.on('end', () => {
        if (keysToDelete.length === 0) {
          resolve();
          return;
        }

        client
          .del(keysToDelete)
          .then(() => {
            this.logger.log(
              `Cleared ${keysToDelete.length} keys matching pattern: ${pattern}`,
            );
            resolve();
          })
          .catch((err) => {
            this.logger.error(
              `Error deleting keys for pattern ${pattern}: ${err.message}`,
              err.stack,
            );
            reject(err);
          });
      });

      stream.on('error', (err) => {
        this.logger.error(
          `Error scanning keys for pattern ${pattern}: ${err.message}`,
          err.stack,
        );
        reject(err);
      });
    });
  }
}
