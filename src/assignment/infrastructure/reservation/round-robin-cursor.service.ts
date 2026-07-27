import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../../redis/redis.tokens';

/**
 * The round-robin cursor, shared by every adapter.
 *
 * Key: `assign:rr:{cursorScope}` → id of the last candidate served.
 *
 * Two deliberate choices, both fixes to what the old engines did:
 *
 * 1. The cursor stores an **id**, not an index. `omni:rr:*` was an `INCR`
 *    counter used with `% pool.length`: every join or departure re-points the
 *    modulo at a different person, which biases the head of the list. An id
 *    cursor survives pool changes — the candidate that follows it is still the
 *    candidate that follows it.
 *
 * 2. The cursor scope is **narrower than the load scope**. Rotation is fair
 *    within a team; load is a property of a person. Sharing one key, as the
 *    record engine did (`assign:rr:{tenant}:{module}:{group}` also keyed its
 *    load ZSET), means an agent on two teams appears half-loaded on each.
 */
@Injectable()
export class RoundRobinCursorService {
  private readonly logger = new Logger(RoundRobinCursorService.name);

  private readonly TTL_SECONDS = 24 * 3600;

  constructor(@Inject(IOREDIS_CLIENT) private readonly redis: Redis) {}

  private key(cursorScope: string): string {
    return `assign:rr:${cursorScope}`;
  }

  /**
   * Rotate so the candidate after the last-served one comes first.
   *
   * Candidates are sorted by id first, so the ordering is stable regardless of
   * what order group resolution returned them in.
   */
  async rotate(cursorScope: string, candidateIds: string[]): Promise<string[]> {
    if (candidateIds.length <= 1) return [...candidateIds];
    const sorted = [...candidateIds].sort((a, b) => a.localeCompare(b));

    let last: string | null = null;
    try {
      last = await this.redis.get(this.key(cursorScope));
    } catch (err: any) {
      // A cursor read failure costs fairness for one pick, not correctness.
      this.logger.warn(
        `Failed to read round-robin cursor ${cursorScope}: ${err.message}`,
      );
      return sorted;
    }

    if (!last) return sorted;
    const idx = sorted.indexOf(last);
    // -1 means the last-served candidate left the pool — start from the head
    // rather than guessing where they would have been.
    if (idx === -1) return sorted;
    const next = (idx + 1) % sorted.length;
    return [...sorted.slice(next), ...sorted.slice(0, next)];
  }

  /**
   * Record who was just served.
   *
   * Called for every strategy, not only round-robin: switching a scope to
   * round-robin should continue after the last person served, not from wherever
   * a stale cursor pointed.
   */
  async advance(cursorScope: string, candidateId: string): Promise<void> {
    try {
      await this.redis.set(
        this.key(cursorScope),
        candidateId,
        'EX',
        this.TTL_SECONDS,
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to advance round-robin cursor ${cursorScope}: ${err.message}`,
      );
    }
  }
}
