import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../../redis/redis.tokens';
import { AssignmentStrategy } from '../../domain/assignment.types';
import { RoundRobinCursorService } from './round-robin-cursor.service';
import {
  LUA_PREVIEW,
  LUA_RELEASE,
  LUA_RESERVE_CAPACITY_BASED,
  LUA_RESERVE_FIRST_ELIGIBLE,
  LUA_RESERVE_LEAST_BUSY,
} from './reservation.lua';
import { AssignmentStrategyRegistry } from '../../core/assignment-strategy.registry';

/**
 * Atomic reservation over a Redis ZSET of open-work counts.
 *
 * Used by the record adapter. The conversation adapter reserves through
 * AgentPresenceService instead — its counter lives in the presence hash next to
 * heartbeat and per-agent capacity and must stay there — but both satisfy the
 * same LoadPort contract, so the core is indifferent to which is behind it.
 *
 * Keys
 *   `assign:load:{loadScope}` — ZSET member → open-work count
 *   `assign:cap:{loadScope}`  — HASH member → per-candidate capacity override
 *
 * `loadScope` is deliberately per-(tenant, objectType) and NOT per-team:
 * capacity belongs to a person. Rotation, which does belong to a team, lives in
 * RoundRobinCursorService under its own narrower scope.
 */
@Injectable()
export class ZsetReservationService {
  private readonly logger = new Logger(ZsetReservationService.name);

  /**
   * Seeded scores expire so a scope that goes quiet does not keep a stale
   * distribution forever. 24h, not the 5 minutes the old engine used: five
   * minutes was short enough that an ordinary lunch break discarded the
   * morning's increments and reverted the pool to a raw MongoDB count.
   */
  private readonly LOAD_TTL_SECONDS = 24 * 3600;
  private readonly LEASE_TTL_SECONDS = 10 * 60;

  constructor(
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    private readonly cursor: RoundRobinCursorService,
    @Optional() private readonly strategies?: AssignmentStrategyRegistry,
  ) {}

  private loadKey(loadScope: string): string {
    return `assign:load:${loadScope}`;
  }

  private capKey(loadScope: string): string {
    return `assign:cap:${loadScope}`;
  }

  private leaseKey(commandId: string): string {
    return `assign:lease:${commandId}`;
  }

  /**
   * Seed any candidate the ZSET does not know yet from the authoritative store,
   * without overwriting scores that reservations have already moved.
   *
   * `ZADD NX` per member is the whole point: a plain `ZADD` would clobber live
   * counters with a snapshot that is, by definition, older than every
   * reservation taken since it was read.
   */
  async seed(
    loadScope: string,
    loads: Map<string, number>,
    capacities?: Map<string, number>,
  ): Promise<void> {
    if (loads.size === 0) return;
    const key = this.loadKey(loadScope);
    const pipeline = this.redis.pipeline();
    for (const [id, load] of loads) {
      pipeline.zadd(key, 'NX', Math.max(0, load), id);
    }
    pipeline.expire(key, this.LOAD_TTL_SECONDS);

    if (capacities && capacities.size > 0) {
      const ck = this.capKey(loadScope);
      for (const [id, cap] of capacities) {
        if (cap > 0) pipeline.hset(ck, id, String(cap));
      }
      pipeline.expire(ck, this.LOAD_TTL_SECONDS);
    }

    try {
      await pipeline.exec();
    } catch (err: any) {
      this.logger.error(
        `Failed to seed load scores for ${loadScope}: ${err.message}`,
      );
    }
  }

  /** Current scores for the given candidates (0 when unseeded). */
  async scores(
    loadScope: string,
    candidateIds: string[],
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (candidateIds.length === 0) return result;

    // A ZSCORE pipeline rather than ZMSCORE: ZMSCORE needs Redis 6.2 and this
    // runs against whatever the deployment has.
    const key = this.loadKey(loadScope);
    const pipeline = this.redis.pipeline();
    for (const id of candidateIds) pipeline.zscore(key, id);

    try {
      const raw = await pipeline.exec();
      candidateIds.forEach((id, i) => {
        const entry = raw?.[i];
        const value = entry && !entry[0] ? entry[1] : null;
        result.set(id, value == null ? 0 : Number(value));
      });
    } catch (err: any) {
      this.logger.error(
        `Failed to read load scores for ${loadScope}: ${err.message}`,
      );
      for (const id of candidateIds) result.set(id, 0);
    }
    return result;
  }

  async rotate(cursorScope: string, candidateIds: string[]): Promise<string[]> {
    return this.cursor.rotate(cursorScope, candidateIds);
  }

  /**
   * Atomically reserve one candidate.
   *
   * `orderedCandidateIds` must already be rotated for `round-robin`; the script
   * then takes the first eligible entry, so rotation and capacity are honoured
   * in one round trip instead of one EVAL per candidate.
   */
  async reserve(
    scopes: {
      loadScope: string;
      cursorScope: string;
      commandId?: string | null;
    },
    orderedCandidateIds: string[],
    strategy: AssignmentStrategy,
    defaultCapacity: number,
    options?: { hasCapacityOverrides?: boolean },
  ): Promise<string | null> {
    if (orderedCandidateIds.length === 0) return null;

    const leaseKey = scopes.commandId ? this.leaseKey(scopes.commandId) : '';
    if (scopes.commandId) {
      const leased = await this.redis.get(leaseKey);
      if (leased && orderedCandidateIds.includes(leased)) {
        await this.redis.expire(leaseKey, this.LEASE_TTL_SECONDS);
        return leased;
      }
      if (leased) {
        // The policy/candidate pool changed between attempts. Return the stale
        // slot before selecting under the new eligible pool.
        await this.release(scopes.loadScope, leased, scopes.commandId);
      }
    }

    const mode =
      this.strategies?.get(strategy)?.reservationMode ??
      (strategy === 'least-busy'
        ? 'least-load'
        : strategy === 'capacity-based'
          ? 'capacity-load'
          : 'first-eligible');
    const script =
      mode === 'least-load'
        ? LUA_RESERVE_LEAST_BUSY
        : mode === 'capacity-load'
          ? LUA_RESERVE_CAPACITY_BASED
          : LUA_RESERVE_FIRST_ELIGIBLE;

    const capKeyArg = options?.hasCapacityOverrides
      ? this.capKey(scopes.loadScope)
      : '';

    // Redis rejects a capacity of 0 as "nobody can ever be assigned", which is
    // never what a misconfigured setting means. Clamp to 1.
    const capacity =
      Number.isFinite(defaultCapacity) && defaultCapacity > 0
        ? Math.floor(defaultCapacity)
        : 1;

    try {
      const result = await this.redis.eval(
        script,
        3,
        this.loadKey(scopes.loadScope),
        capKeyArg,
        leaseKey,
        String(orderedCandidateIds.length),
        ...orderedCandidateIds,
        String(capacity),
        String(this.LEASE_TTL_SECONDS),
      );
      const reserved = typeof result === 'string' ? result : null;
      if (reserved) await this.cursor.advance(scopes.cursorScope, reserved);
      return reserved;
    } catch (err: any) {
      this.logger.error(
        `Reservation failed for ${scopes.loadScope} (${strategy}): ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Who `reserve()` would pick, without incrementing anything.
   *
   * Shares the capacity resolution and the per-strategy selection rule with the
   * reserve scripts, so a dry run cannot report a different winner than the real
   * decision would choose.
   */
  async preview(
    loadScope: string,
    orderedCandidateIds: string[],
    strategy: AssignmentStrategy,
    defaultCapacity: number,
    options?: { hasCapacityOverrides?: boolean },
  ): Promise<string | null> {
    if (orderedCandidateIds.length === 0) return null;

    const capacity =
      Number.isFinite(defaultCapacity) && defaultCapacity > 0
        ? Math.floor(defaultCapacity)
        : 1;

    try {
      const result = await this.redis.eval(
        LUA_PREVIEW,
        2,
        this.loadKey(loadScope),
        options?.hasCapacityOverrides ? this.capKey(loadScope) : '',
        String(orderedCandidateIds.length),
        ...orderedCandidateIds,
        String(capacity),
        strategy,
      );
      return typeof result === 'string' ? result : null;
    } catch (err: any) {
      this.logger.error(
        `Preview failed for ${loadScope} (${strategy}): ${err.message}`,
      );
      return null;
    }
  }

  /** Exact inverse of one `reserve()`. Never throws. */
  async release(
    loadScope: string,
    candidateId: string,
    commandId?: string | null,
  ): Promise<void> {
    try {
      await this.redis.eval(
        LUA_RELEASE,
        1,
        this.loadKey(loadScope),
        candidateId,
      );
      if (commandId) await this.redis.del(this.leaseKey(commandId));
    } catch (err: any) {
      this.logger.error(
        `Failed to release reservation for ${candidateId} in ${loadScope}: ${err.message}`,
      );
    }
  }

  async completeLease(commandId?: string | null): Promise<void> {
    if (!commandId) return;
    await this.redis.del(this.leaseKey(commandId));
  }

  /**
   * Adjust an already-seeded workload projection.
   *
   * Missing members are deliberately left missing: their first assignment read
   * will seed the authoritative Mongo count. This avoids racing a lifecycle
   * event against the initial aggregate and double-counting the same record.
   */
  async adjustIfTracked(
    loadScope: string,
    candidateId: string,
    delta: number,
  ): Promise<boolean> {
    if (!candidateId || !Number.isFinite(delta) || delta === 0) return false;
    const script = `
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score then return 0 end
local next = tonumber(score) + tonumber(ARGV[2])
if next < 0 then next = 0 end
redis.call('ZADD', KEYS[1], next, ARGV[1])
return 1
`;
    try {
      const result = await this.redis.eval(
        script,
        1,
        this.loadKey(loadScope),
        candidateId,
        String(Math.trunc(delta)),
      );
      return Number(result) === 1;
    } catch (err: any) {
      this.logger.error(
        `Failed to adjust tracked load for ${candidateId} in ${loadScope}: ${err.message}`,
      );
      return false;
    }
  }

  /** Discover active record workload scopes without using Redis KEYS. */
  async trackedLoadScopes(): Promise<string[]> {
    const scopes: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        'assign:load:*',
        'COUNT',
        100,
      );
      cursor = next;
      for (const key of keys) scopes.push(key.slice('assign:load:'.length));
    } while (cursor !== '0');
    return [...new Set(scopes)];
  }

  async trackedMembers(loadScope: string): Promise<string[]> {
    return this.redis.zrange(this.loadKey(loadScope), 0, -1);
  }

  /** Replace only existing scores with an authoritative workload snapshot. */
  async overwriteTracked(
    loadScope: string,
    loads: Map<string, number>,
  ): Promise<void> {
    if (loads.size === 0) return;
    const pipeline = this.redis.pipeline();
    const key = this.loadKey(loadScope);
    for (const [candidateId, load] of loads) {
      pipeline.zadd(key, 'XX', Math.max(0, load), candidateId);
    }
    pipeline.expire(key, this.LOAD_TTL_SECONDS);
    await pipeline.exec();
  }
}
