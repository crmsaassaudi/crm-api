import { Injectable, Logger, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';

/**
 * StrategyExecutorService — shared strategy logic reusable by
 * both the Assignment Engine (CRM entities) and Omni-Channel.
 *
 * Strategies:
 *   - round-robin: Redis atomic counter scoped by key
 *   - least-busy: pick candidate with fewest active entities, with optional
 *     Redis reservation to avoid concurrent stale-read races
 */
@Injectable()
export class StrategyExecutorService {
  private readonly logger = new Logger(StrategyExecutorService.name);
  private readonly leastBusyReservationScript = `
    local key = KEYS[1]
    local candidateCount = tonumber(ARGV[1])
    local bestCandidate = nil
    local bestLoad = nil

    for i = 1, candidateCount do
      local candidate = ARGV[i + 1]
      local score = redis.call('ZSCORE', key, candidate)
      if score then
        local load = tonumber(score)
        if bestLoad == nil or load < bestLoad then
          bestLoad = load
          bestCandidate = candidate
        end
      end
    end

    if not bestCandidate then return nil end
    redis.call('ZINCRBY', key, 1, bestCandidate)
    return { bestCandidate, tostring(bestLoad) }
  `;

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

  /**
   * Atomic least-busy reservation backed by a Redis sorted set.
   *
   * The MongoDB load map is only used to seed missing candidates. Existing
   * Redis scores are not overwritten, so concurrent assignments increment the
   * same counter instead of repeatedly picking the same stale DB minimum.
   */
  async leastBusyAtomic(
    scope: string,
    loadMap: Map<string, number>,
    ttlSeconds = 300,
  ): Promise<{
    candidateId: string;
    load: number;
  }> {
    if (loadMap.size === 0) {
      throw new Error('Least-busy called with empty load map');
    }

    const key = `assign:load:${scope}`;
    const candidates = Array.from(loadMap.keys());
    const pipeline = this.redis.pipeline();

    for (const [candidateId, load] of loadMap) {
      pipeline.zadd(key, 'NX', load, candidateId);
    }
    pipeline.expire(key, ttlSeconds);
    await pipeline.exec();

    const result = await this.redis.eval(
      this.leastBusyReservationScript,
      1,
      key,
      candidates.length.toString(),
      ...candidates,
    );

    if (!Array.isArray(result) || typeof result[0] !== 'string') {
      throw new Error('Least-busy could not reserve a candidate');
    }

    const candidateId = result[0];
    const load = Number(result[1] ?? 0);
    this.logger.debug(
      `Least-busy atomic [${scope}]: selected=${candidateId} with load=${load} (pool size=${loadMap.size})`,
    );
    return { candidateId, load };
  }
}
