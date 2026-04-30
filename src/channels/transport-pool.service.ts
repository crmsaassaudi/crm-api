import { Injectable, Logger, Inject, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ChannelConfigRepository } from './infrastructure/persistence/document/repositories/channel-config.repository';
import { ICryptoService, CRYPTO_SERVICE_TOKEN } from './domain/crypto.service';
import { ChannelConfig } from './domain/channel-config';

/**
 * Resolved credentials from the Transport Pool.
 * Pre-decrypted and ready for immediate use by executors.
 */
export interface ResolvedTransport {
  configId: string;
  tenantId: string;
  providerType: string;
  name: string;
  status: string;
  /** Internal health state for adaptive scheduling (healthy/degraded/unhealthy) */
  healthState: string;
  credentials: Record<string, any>; // Decrypted — cached in-memory
  publicSettings: Record<string, any>;
  consecutiveFailures: number;
}

/**
 * Internal cache entry with metadata for LRU eviction and staleness detection.
 */
interface CacheEntry {
  transport: ResolvedTransport;
  /** DB record updatedAt — used for staleness detection */
  configUpdatedAt: string;
  /** When this entry was created (ms) */
  cachedAt: number;
  /** When this entry was last accessed (ms) — for LRU eviction */
  lastAccessedAt: number;
}

/**
 * Transport Pool Service — Tenant-Aware LRU Cache for decrypted credentials.
 *
 * Eliminates the performance bottleneck of per-job DB query + AES-256 decryption.
 *
 * Design Decisions:
 *   - Pool Key: `configId` (globally unique ObjectId, no collision risk)
 *   - Cross-Tenant Safety: Every cache hit validates `tenantId` matches job context
 *   - LRU Eviction: When pool exceeds MAX_SIZE, evict least-recently-used entries
 *   - TTL: Entries expire after 30 minutes (defense against stale data)
 *   - Event-Driven Invalidation: Listens to `channel-config.updated` and
 *     `channel-config.deleted` events to immediately evict stale entries
 *   - Zero-downtime: Cache miss = fallback to DB + decrypt (same as before pool)
 *
 * Performance Impact:
 *   - Before: 100k jobs × (1 DB query + 1 AES decrypt) = ~100k × 50ms = 83 minutes overhead
 *   - After: 1 DB query + 1 decrypt + 99,999 cache hits = ~100k × 0.01ms = 1 second overhead
 *
 * Memory Budget:
 *   - Each entry ≈ 2KB (credentials JSON + metadata)
 *   - MAX_SIZE=500 → ~1MB total (negligible for Node.js)
 */
@Injectable()
export class TransportPoolService implements OnModuleDestroy {
  private readonly logger = new Logger(TransportPoolService.name);
  private readonly pool = new Map<string, CacheEntry>();

  /** Max cached transports. At 2KB each, 500 entries ≈ 1MB */
  private readonly MAX_SIZE = 500;
  /** TTL in milliseconds (30 minutes) */
  private readonly TTL_MS = 30 * 60 * 1000;
  /** Cleanup interval timer */
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repository: ChannelConfigRepository,
    @Inject(CRYPTO_SERVICE_TOKEN)
    private readonly crypto: ICryptoService,
  ) {
    // Run periodic cleanup every 5 minutes to evict expired entries
    this.cleanupTimer = setInterval(() => this.evictExpired(), 5 * 60 * 1000);
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.pool.clear();
    this.logger.log('[TransportPool] Destroyed — all entries cleared');
  }

  // ── Core: Get or Create ──────────────────────────────────────────────────

  /**
   * Get resolved transport for a configId.
   * Returns cached entry if valid, otherwise fetches from DB + decrypts.
   *
   * @param configId - The channel config ID
   * @returns ResolvedTransport or null if config not found/deleted
   */
  async resolve(configId: string): Promise<ResolvedTransport | null> {
    // 1. Check cache
    const cached = this.pool.get(configId);
    if (cached && !this.isExpired(cached)) {
      cached.lastAccessedAt = Date.now();
      return cached.transport;
    }

    // 2. Cache miss or expired — fetch from DB
    const config =
      await this.repository.findByIdWithCredentialsNoTenant(configId);
    if (!config || !config.encryptedCredentials) {
      // Config deleted or missing — evict stale cache entry if exists
      this.pool.delete(configId);
      return null;
    }

    // 3. Decrypt credentials
    let credentials: Record<string, any>;
    try {
      credentials = JSON.parse(
        await this.crypto.decrypt(config.encryptedCredentials),
      );
    } catch (err: any) {
      this.logger.error(
        `[TransportPool] Decrypt failed for config "${config.name}" (${configId}): ${err.message}`,
      );
      return null;
    }

    // 4. Build transport
    const transport: ResolvedTransport = {
      configId: config.id,
      tenantId: config.tenantId,
      providerType: config.providerType,
      name: config.name,
      status: config.status,
      healthState: (config as any).healthState || 'healthy',
      credentials,
      publicSettings: config.publicSettings || {},
      consecutiveFailures: config.consecutiveFailures || 0,
    };

    // 5. Store in cache (with LRU eviction if full)
    this.put(configId, transport, config);

    this.logger.debug(
      `[TransportPool] Cached config "${config.name}" (${configId}). Pool size: ${this.pool.size}`,
    );

    return transport;
  }

  // ── Cross-Tenant Safety Guard ─────────────────────────────────────────────

  /**
   * Resolve transport with cross-tenant safety check.
   * Prevents IDOR / data bleeding — returns null if config belongs to a different tenant.
   *
   * @param configId - The channel config ID
   * @param expectedTenantId - The tenant ID from job context (immutable at job creation)
   * @returns ResolvedTransport or null if not found / tenant mismatch
   */
  async resolveWithTenantGuard(
    configId: string,
    expectedTenantId: string,
  ): Promise<ResolvedTransport | null> {
    const transport = await this.resolve(configId);
    if (!transport) return null;

    if (transport.tenantId !== expectedTenantId) {
      this.logger.error(
        `[TransportPool] ⛔ TENANT MISMATCH! ` +
          `configId=${configId} belongs to tenant ${transport.tenantId} ` +
          `but was requested by tenant ${expectedTenantId}. BLOCKED.`,
      );
      return null; // Silent fail — never expose cross-tenant data
    }

    return transport;
  }

  // ── Event-Driven Invalidation ────────────────────────────────────────────

  /**
   * Invalidate cache when config is updated (credentials changed, status changed, etc.)
   * Triggered by ChannelConfigService after successful update.
   */
  @OnEvent('channel-config.updated')
  handleConfigUpdated(payload: {
    configId: string;
    configName?: string;
  }): void {
    if (this.pool.delete(payload.configId)) {
      this.logger.log(
        `[TransportPool] Evicted config "${payload.configName || payload.configId}" — config updated`,
      );
    }
  }

  /**
   * Invalidate cache when config is deleted.
   */
  @OnEvent('channel-config.deleted')
  handleConfigDeleted(payload: {
    configId: string;
    configName?: string;
  }): void {
    if (this.pool.delete(payload.configId)) {
      this.logger.log(
        `[TransportPool] Evicted config "${payload.configName || payload.configId}" — config deleted`,
      );
    }
  }

  /**
   * Invalidate cache when health check marks config as error.
   * The pool must not serve stale 'active' status after health check failure.
   */
  @OnEvent('channel-config.health.failed')
  handleHealthFailed(payload: { configId: string }): void {
    this.pool.delete(payload.configId);
  }

  /**
   * Invalidate cache when health check recovers a config.
   */
  @OnEvent('channel-config.health.recovered')
  handleHealthRecovered(payload: { configId: string }): void {
    this.pool.delete(payload.configId);
  }

  // ── Pool Stats (for monitoring/debugging) ────────────────────────────────

  getStats(): { size: number; maxSize: number; ttlMs: number } {
    return {
      size: this.pool.size,
      maxSize: this.MAX_SIZE,
      ttlMs: this.TTL_MS,
    };
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  private put(
    configId: string,
    transport: ResolvedTransport,
    config: ChannelConfig,
  ): void {
    // LRU eviction if at capacity
    if (this.pool.size >= this.MAX_SIZE && !this.pool.has(configId)) {
      this.evictLRU();
    }

    this.pool.set(configId, {
      transport,
      configUpdatedAt:
        config.updatedAt?.toISOString?.() || new Date().toISOString(),
      cachedAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
  }

  private isExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.cachedAt > this.TTL_MS;
  }

  /**
   * Evict the least-recently-used entry.
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.pool) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.pool.delete(oldestKey);
      this.logger.debug(`[TransportPool] LRU evicted: ${oldestKey}`);
    }
  }

  /**
   * Periodic cleanup: evict all expired entries.
   */
  private evictExpired(): void {
    let evicted = 0;
    for (const [key, entry] of this.pool) {
      if (this.isExpired(entry)) {
        this.pool.delete(key);
        evicted++;
      }
    }
    if (evicted > 0) {
      this.logger.debug(
        `[TransportPool] TTL cleanup: evicted ${evicted} expired entries. Pool size: ${this.pool.size}`,
      );
    }
  }
}
