import { Inject, Injectable, Logger } from '@nestjs/common';
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

  constructor(
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    private readonly cursor: RoundRobinCursorService,
  ) {}

  private loadKey(loadScope: string): string {
    return `assign:load:${loadScope}`;
  }

  private capKey(loadScope: string): string {
    return `assign:cap:${loadScope}`;
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
    scopes: { loadScope: string; cursorScope: string },
    orderedCandidateIds: string[],
    strategy: AssignmentStrategy,
    defaultCapacity: number,
    options?: { hasCapacityOverrides?: boolean },
  ): Promise<string | null> {
    if (orderedCandidateIds.length === 0) return null;

    const script =
      strategy === 'least-busy'
        ? LUA_RESERVE_LEAST_BUSY
        : strategy === 'capacity-based'
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
        2,
        this.loadKey(scopes.loadScope),
        capKeyArg,
        String(orderedCandidateIds.length),
        ...orderedCandidateIds,
        String(capacity),
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
  async release(loadScope: string, candidateId: string): Promise<void> {
    try {
      await this.redis.eval(
        LUA_RELEASE,
        1,
        this.loadKey(loadScope),
        candidateId,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to release reservation for ${candidateId} in ${loadScope}: ${err.message}`,
      );
    }
  }
}
