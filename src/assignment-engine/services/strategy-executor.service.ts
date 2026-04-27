import { Injectable, Logger, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';

/**
 * StrategyExecutorService — shared strategy logic reusable by
 * both the Assignment Engine (CRM entities) and Omni-Channel.
 *
 * Strategies:
 *   - round-robin: Redis atomic counter scoped by key
 *   - least-busy: pick candidate with fewest active entities
 */
@Injectable()
export class StrategyExecutorService {
  private readonly logger = new Logger(StrategyExecutorService.name);

  constructor(@Inject(IOREDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Round-robin: use a Redis atomic counter to cycle through candidates.
   * Key format: `assign:rr:{tenantId}:{module}:{teamId}`
   * Scoped per module+team to ensure fairness within each pool.
   */
  async roundRobin(scope: string, candidates: string[]): Promise<string> {
    if (candidates.length === 0) {
      throw new Error('Round-robin called with empty candidate list');
    }
    if (candidates.length === 1) return candidates[0];

    const key = `assign:rr:${scope}`;
    const counter = await this.redis.incr(key);
    // Set TTL on first creation (24h)
    if (counter === 1) {
      await this.redis.expire(key, 86400);
    }
    const index = (counter - 1) % candidates.length;
    this.logger.debug(
      `Round-robin [${scope}]: counter=${counter}, index=${index}, selected=${candidates[index]}`,
    );
    return candidates[index];
  }

  /**
   * Least-busy: pick the candidate with fewest items in a given load map.
   * The caller provides a map of candidateId → currentLoad.
   */
  leastBusy(loadMap: Map<string, number>): {
    candidateId: string;
    load: number;
  } {
    if (loadMap.size === 0) {
      throw new Error('Least-busy called with empty load map');
    }

    let minId = '';
    let minLoad = Infinity;

    for (const [id, load] of loadMap) {
      if (load < minLoad) {
        minLoad = load;
        minId = id;
      }
    }

    this.logger.debug(
      `Least-busy: selected=${minId} with load=${minLoad} (pool size=${loadMap.size})`,
    );
    return { candidateId: minId, load: minLoad };
  }
}
