import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ulid } from 'ulid';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import type Redis from 'ioredis';
import { LRUCache } from 'lru-cache';

export interface SessionData {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  userId: string;
  expiresAt: number; // Unix ms timestamp when access_token expires
}

const SESSION_PREFIX = 'session:';
const SESSION_BY_USER_PREFIX = 'session:byuser:';
const SESSION_TTL_SECONDS = 86_400; // 24 hours — long-lived to allow many refresh cycles
const LRU_TTL_MS = 60_000; // 1-minute in-memory cache per entry

interface LruEntry {
  data: SessionData;
  cachedAt: number;
}

/** Pub/Sub channel carrying cross-instance session invalidations. */
const SESSION_INVALIDATION_CHANNEL = 'session:invalidated';

@Injectable()
export class SessionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionService.name);

  // lru-cache: evicts by true least-recently-used access order + TTL auto-expiry
  private readonly lru = new LRUCache<string, LruEntry>({
    max: 1000,
    ttl: LRU_TTL_MS,
  });

  /** Dedicated connection — a subscribed client cannot serve normal commands. */
  private subscriber?: Redis;

  constructor(@Inject(IOREDIS_CLIENT) private readonly ioredis: Redis) {}

  /**
   * Subscribe to cross-instance session invalidation (H-02).
   *
   * `getSession` reads a 60 s in-process LRU before Redis, and `deleteSession`
   * could only clear the LRU of the instance that handled the logout. Behind a
   * load balancer that meant a logged-out or deactivated session stayed valid on
   * every other replica for up to a minute — a revocation gap that no amount of
   * Redis correctness could close from one process.
   */
  async onModuleInit(): Promise<void> {
    try {
      this.subscriber = this.ioredis.duplicate();
      await this.subscriber.subscribe(SESSION_INVALIDATION_CHANNEL);
      this.subscriber.on('message', (_channel, sid) => {
        if (sid) this.lru.delete(sid);
      });
    } catch (error) {
      // A failed subscription must be loud: without it, revocation is silently
      // only local again. The service still works, but the operator has to know.
      this.logger.error(
        `Failed to subscribe to ${SESSION_INVALIDATION_CHANNEL}; session revocation will NOT propagate across instances: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.quit().catch(() => {
      /* shutting down anyway */
    });
  }

  async createSession(
    tokens: {
      access_token: string;
      refresh_token: string;
      id_token: string;
      expires_in: number; // seconds
    },
    userId: string,
  ): Promise<string> {
    const sid = ulid();
    const expiresAt = Date.now() + tokens.expires_in * 1000;

    const session: SessionData = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      userId,
      expiresAt,
    };

    // Use raw ioredis SET EX (seconds) — avoids cache-manager v7 ms TTL issues
    // Session lives 24h; the guard auto-refreshes the access_token when it expires
    await this.ioredis.set(
      `${SESSION_PREFIX}${sid}`,
      JSON.stringify(session),
      'EX',
      SESSION_TTL_SECONDS,
    );

    // Reverse index so an admin action (deactivate, platformRole downgrade,
    // tenant removal) can kill this user's live sessions instead of waiting
    // out the 24h TTL.
    const byUserKey = `${SESSION_BY_USER_PREFIX}${userId}`;
    await this.ioredis.sadd(byUserKey, sid);
    await this.ioredis.expire(byUserKey, SESSION_TTL_SECONDS);

    this.setLru(sid, session);
    return sid;
  }

  async getSession(sid: string): Promise<SessionData | null> {
    // 1. Check in-memory LRU first (lru-cache handles TTL + LRU eviction)
    const cached = this.lru.get(sid);
    if (cached) {
      return cached.data;
    }

    // 2. Fallback to raw ioredis
    const raw = await this.ioredis.get(`${SESSION_PREFIX}${sid}`);
    if (!raw) return null;

    const session: SessionData = JSON.parse(raw);
    this.setLru(sid, session);
    return session;
  }

  async getSessionFresh(sid: string): Promise<SessionData | null> {
    const raw = await this.ioredis.get(`${SESSION_PREFIX}${sid}`);
    if (!raw) {
      this.lru.delete(sid);
      return null;
    }

    const session: SessionData = JSON.parse(raw);
    this.setLru(sid, session);
    return session;
  }

  async updateSession(
    sid: string,
    session: SessionData,
    newTtlSeconds: number,
  ): Promise<void> {
    await this.ioredis.set(
      `${SESSION_PREFIX}${sid}`,
      JSON.stringify(session),
      'EX',
      newTtlSeconds,
    );
    this.setLru(sid, session);
  }

  async deleteSession(sid: string): Promise<void> {
    // Read before delete so the by-user index can be cleaned up too — best
    // effort: a stale entry in that set is harmless (deleteAllSessionsForUser
    // just no-ops on an already-gone key), missing the DEL below is not.
    const cached = this.lru.get(sid)?.data;
    const userId =
      cached?.userId ??
      (await this.ioredis
        .get(`${SESSION_PREFIX}${sid}`)
        .then((raw) => (raw ? (JSON.parse(raw) as SessionData).userId : null))
        .catch(() => null));

    await this.ioredis.del(`${SESSION_PREFIX}${sid}`);
    this.lru.delete(sid);
    if (userId) {
      await this.ioredis
        .srem(`${SESSION_BY_USER_PREFIX}${userId}`, sid)
        .catch(() => undefined);
    }
    // Tell every other instance to drop its cached copy immediately (H-02).
    await this.ioredis
      .publish(SESSION_INVALIDATION_CHANNEL, sid)
      .catch((error) =>
        this.logger.warn(
          `Failed to publish session invalidation for ${sid}; other instances may serve it for up to ${
            LRU_TTL_MS / 1000
          }s: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }

  /**
   * Kill every live session for a user — used when an admin action revokes
   * their standing access (deactivation, platformRole downgrade, removal from
   * a tenant) so they cannot keep acting on a still-valid 24h session/token.
   */
  async deleteAllSessionsForUser(userId: string): Promise<void> {
    const byUserKey = `${SESSION_BY_USER_PREFIX}${userId}`;
    const sids = await this.ioredis.smembers(byUserKey);
    await Promise.all(sids.map((sid) => this.deleteSession(sid)));
    await this.ioredis.del(byUserKey);
  }

  private setLru(sid: string, data: SessionData): void {
    this.lru.set(sid, { data, cachedAt: Date.now() });
  }
}
