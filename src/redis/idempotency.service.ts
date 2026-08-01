import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { IOREDIS_CLIENT } from './redis.tokens';

/** Marker stored once the work behind a key has actually finished. */
const COMMITTED = 'committed';

/**
 * How long a claim is held before another owner may take it over.
 *
 * Long enough that no realistic handler outlives it, short enough that a killed
 * worker does not block a redelivery for hours.
 */
export const DEFAULT_LEASE_SECONDS = 300;

/** How long a committed key is remembered, i.e. the deduplication window. */
export const DEFAULT_COMMIT_TTL_SECONDS = 86_400;

/**
 * Claim the key, or refresh a claim this owner already holds.
 *
 * Returns 1 when the caller may proceed, 0 when someone else owns the key or it
 * is already committed.
 */
const CLAIM_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == false or current == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return 1
end
return 0
`;

/**
 * Distributed "process this exactly once" marker.
 *
 * The pattern is **claim → work → commit**, not "mark then work". Marking a key
 * as processed before doing the work looks like deduplication but is really an
 * at-most-once delivery: if the process dies between the mark and the write,
 * the marker survives, every retry sees it, and the message is silently lost
 * for the lifetime of the key. Compensating with a `DEL` in a `catch` block
 * does not close that hole either — `catch` does not run for an OOM kill, a
 * SIGKILL or a pod eviction, which is exactly when it matters.
 *
 * Here a claim is a *lease*. It only becomes a permanent "already handled"
 * marker once {@link commit} is called, so an interrupted attempt is retried
 * rather than swallowed.
 *
 * `owner` identifies the unit of work, not the attempt — pass a queue job id.
 * A retry of the same job re-enters its own claim, while an unrelated
 * redelivery of the same message backs off while the first owner is still
 * working.
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(IOREDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Try to take ownership of `key`.
   *
   * @returns true when the caller should do the work.
   */
  async claim(
    key: string,
    owner: string,
    leaseSeconds = DEFAULT_LEASE_SECONDS,
  ): Promise<boolean> {
    const claimed = await this.redis.eval(
      CLAIM_SCRIPT,
      1,
      key,
      owner,
      String(leaseSeconds),
    );
    return claimed === 1;
  }

  /**
   * Mark the work as finished. Only after this does the key deduplicate.
   */
  async commit(
    key: string,
    ttlSeconds = DEFAULT_COMMIT_TTL_SECONDS,
  ): Promise<void> {
    await this.redis.set(key, COMMITTED, 'EX', ttlSeconds);
  }

  /**
   * Drop the claim so the next delivery can retry immediately.
   *
   * Only for terminal outcomes the caller wants reprocessed later — a channel
   * that has since been reconnected, say. Ordinary failures need no release:
   * the queue retries under the same owner, and the lease expires on its own.
   */
  async release(key: string): Promise<void> {
    await this.redis.del(key).catch(() => undefined);
  }
}
