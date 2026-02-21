import { Injectable, Inject } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import type Redis from 'ioredis';

export interface SessionData {
    accessToken: string;
    refreshToken: string;
    idToken: string;
    userId: string;
    expiresAt: number; // Unix ms timestamp when access_token expires
}

const SESSION_PREFIX = 'session:';
const LRU_TTL_MS = 60_000; // 1-minute in-memory cache per entry

interface LruEntry {
    data: SessionData;
    cachedAt: number;
}

@Injectable()
export class SessionService {
    private readonly lru = new Map<string, LruEntry>();
    private readonly MAX_LRU = 1000;

    constructor(
        @Inject(IOREDIS_CLIENT) private readonly ioredis: Redis,
    ) { }

    async createSession(tokens: {
        access_token: string;
        refresh_token: string;
        id_token: string;
        expires_in: number; // seconds
    }, userId: string): Promise<string> {
        const sid = uuidv4();
        const expiresAt = Date.now() + tokens.expires_in * 1000;

        const session: SessionData = {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            idToken: tokens.id_token,
            userId,
            expiresAt,
        };

        // Use raw ioredis SET EX (seconds) — avoids cache-manager v7 ms TTL issues
        const ttlSeconds = tokens.expires_in + 60; // +60s buffer for refresh window
        await this.ioredis.set(
            `${SESSION_PREFIX}${sid}`,
            JSON.stringify(session),
            'EX',
            ttlSeconds,
        );

        this.setLru(sid, session);
        return sid;
    }

    async getSession(sid: string): Promise<SessionData | null> {
        // 1. Check in-memory LRU first
        const cached = this.lru.get(sid);
        if (cached && Date.now() - cached.cachedAt < LRU_TTL_MS) {
            return cached.data;
        }

        // 2. Fallback to raw ioredis
        const raw = await this.ioredis.get(`${SESSION_PREFIX}${sid}`);
        if (!raw) return null;

        const session: SessionData = JSON.parse(raw);
        this.setLru(sid, session);
        return session;
    }

    async updateSession(sid: string, session: SessionData, newTtlSeconds: number): Promise<void> {
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
        if (this.lru.size >= this.MAX_LRU) {
            const firstKey = this.lru.keys().next().value;
            if (firstKey) this.lru.delete(firstKey);
        }
        this.lru.set(sid, { data, cachedAt: Date.now() });
    }
}
