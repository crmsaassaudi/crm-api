import { Injectable, Inject } from '@nestjs/common';
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
const SESSION_TTL_SECONDS = 86_400; // 24 hours — long-lived to allow many refresh cycles
const LRU_TTL_MS = 60_000; // 1-minute in-memory cache per entry

interface LruEntry {
  data: SessionData;
  cachedAt: number;
}

@Injectable()
export class SessionService {
  // lru-cache: evicts by true least-recently-used access order + TTL auto-expiry
  private readonly lru = new LRUCache<string, LruEntry>({
    max: 1000,
    ttl: LRU_TTL_MS,
  });

  constructor(@Inject(IOREDIS_CLIENT) private readonly ioredis: Redis) {}

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
    await this.ioredis.del(`${SESSION_PREFIX}${sid}`);
    this.lru.delete(sid);
  }

  private setLru(sid: string, data: SessionData): void {
    this.lru.set(sid, { data, cachedAt: Date.now() });
  }
}
