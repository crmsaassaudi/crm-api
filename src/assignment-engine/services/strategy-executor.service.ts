import { Injectable, Logger, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';

/**
 * StrategyExecutorService — shared strategy logic reusable by
 * both the Assignment Engine (CRM entities) and Omni-Channel.
 *
 * Strategies:
 *   - round-robin: cursor of last-assigned agent scoped by key, advancing to
 *     the next agent in a stable (id-sorted) ordering
 *   - least-busy: pick candidate with fewest active entities, with optional
 *     Redis reservation to avoid concurrent stale-read races
 *
 * Reservation contract (CRIT-05):
 *   When `reserve === true` (the default), selecting a candidate also mutates
 *   shared Redis state (round-robin cursor advance / least-busy ZINCRBY) so the
 *   NEXT call sees the updated load. This is optimistic: the caller is expected
 *   to persist the resulting ownerId. If persistence FAILS, the caller MUST call
 *   `AssignmentEngineService.compensate({...})` → `release()` to roll back the
 *   reservation, otherwise the counter drifts. When `reserve === false`
 *   (dry-run), selection is read-only and no compensation is needed.
 */
@Injectable()
export class StrategyExecutorService {
  private readonly logger = new Logger(StrategyExecutorService.name);
  // Atomically reserve (ZINCRBY +1) the least-loaded candidate.
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
  // Read-only variant: find the least-loaded candidate WITHOUT incrementing.
  private readonly leastBusyReadOnlyScript = `
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
    return { bestCandidate, tostring(bestLoad) }
  `;

  constructor(@Inject(IOREDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Round-robin: advance a per-scope cursor (last-assigned agent id) through a
   * stably-sorted candidate list and return the agent that comes AFTER it.
   *
   * Sorting candidates by id makes the ordering deterministic regardless of the
   * order Mongo/group resolution returns them, so adding/removing an agent no
   * longer shifts the modulo and biases the head of the list (CRIT-07).
   *
   * Key format: `assign:rr:{scope}` storing the last-assigned candidate id.
   *
   * @param reserve when true (default) persist the new cursor; when false
   *   (dry-run) compute the pick without mutating Redis.
   * @returns selected candidate id, or `null` if the pool is empty (CRIT-08 —
   *   callers already guard on eligible.length === 0 and fall back).
   */
  async roundRobin(
    scope: string,
    candidates: string[],
    reserve = true,
  ): Promise<string | null> {
    if (candidates.length === 0) {
      this.logger.warn(`Round-robin [${scope}] called with empty candidates`);
      return null;
    }

    const sorted = [...candidates].sort();
    if (sorted.length === 1) {
      if (reserve) await this.setRoundRobinCursor(scope, sorted[0]);
      return sorted[0];
    }

    const key = `assign:rr:${scope}`;
    const lastAssignedId = await this.redis.get(key);

    let nextIndex = 0;
    if (lastAssignedId) {
      const lastIdx = sorted.indexOf(lastAssignedId);
      // lastIdx === -1 (agent left the pool) → start at the head.
      nextIndex = lastIdx === -1 ? 0 : (lastIdx + 1) % sorted.length;
    }

    const selected = sorted[nextIndex];
    if (reserve) await this.setRoundRobinCursor(scope, selected);

    this.logger.debug(
      `Round-robin [${scope}]: last=${lastAssignedId ?? 'none'}, next=${selected} (reserve=${reserve})`,
    );
    return selected;
  }

  private async setRoundRobinCursor(
    scope: string,
    candidateId: string,
  ): Promise<void> {
    const key = `assign:rr:${scope}`;
    // 24h TTL refreshed on each write.
    await this.redis.set(key, candidateId, 'EX', 86400);
  }

  /**
   * @deprecated Non-atomic in-memory least-busy selection — kept only for the
   * existing unit spec and historical reference. Production paths MUST use
   * {@link leastBusyAtomic}, which reserves the pick in Redis to avoid races.
   * No production caller invokes this (verified via grep).
   */
  leastBusy(loadMap: Map<string, number>): {
    candidateId: string;
    load: number;
  } | null {
    if (loadMap.size === 0) {
      this.logger.warn('Least-busy called with empty load map');
      return null;
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
   *
   * @param reserve when true (default) the least-loaded candidate is reserved
   *   via ZINCRBY +1; when false (dry-run) the pick is computed read-only.
   * @returns the selected candidate + its (pre-increment) load, or `null` when
   *   the pool is empty (CRIT-08 — caller guards and falls back).
   */
  async leastBusyAtomic(
    scope: string,
    loadMap: Map<string, number>,
    ttlSeconds = 300,
    reserve = true,
  ): Promise<{
    candidateId: string;
    load: number;
  } | null> {
    if (loadMap.size === 0) {
      this.logger.warn(`Least-busy [${scope}] called with empty load map`);
      return null;
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
      reserve ? this.leastBusyReservationScript : this.leastBusyReadOnlyScript,
      1,
      key,
      candidates.length.toString(),
      ...candidates,
    );

    if (!Array.isArray(result) || typeof result[0] !== 'string') {
      this.logger.warn(`Least-busy [${scope}] could not reserve a candidate`);
      return null;
    }

    const candidateId = result[0];
    const load = Number(result[1] ?? 0);
    this.logger.debug(
      `Least-busy atomic [${scope}]: selected=${candidateId} with load=${load} (pool size=${loadMap.size}, reserve=${reserve})`,
    );
    return { candidateId, load };
  }

  /**
   * Compensating action for the reservation contract (CRIT-05).
   *
   * Rolls back a previously-reserved selection when the caller fails to persist
   * the chosen ownerId:
   *   - round-robin: the cursor is best-effort reset only if it still points at
   *     `candidateId` (we cannot reconstruct the previous agent, so we simply
   *     clear it; the next call then starts from the head — acceptable, since
   *     round-robin fairness is statistical).
   *   - least-busy: ZINCRBY -1 to undo the load increment.
   */
  async release(
    scope: string,
    candidateId: string,
    strategy: string,
  ): Promise<void> {
    try {
      if (strategy === 'least-busy') {
        const key = `assign:load:${scope}`;
        await this.redis.zincrby(key, -1, candidateId);
        this.logger.debug(
          `Released least-busy reservation [${scope}] for ${candidateId}`,
        );
        return;
      }

      // round-robin (and default)
      const key = `assign:rr:${scope}`;
      const current = await this.redis.get(key);
      if (current === candidateId) {
        await this.redis.del(key);
        this.logger.debug(
          `Released round-robin cursor [${scope}] (was ${candidateId})`,
        );
      }
    } catch (err: any) {
      this.logger.error(
        `Failed to release reservation [${scope}] for ${candidateId}: ${err.message}`,
      );
    }
  }
}
