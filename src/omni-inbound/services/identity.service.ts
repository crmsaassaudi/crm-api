import { Injectable, Logger, Inject } from '@nestjs/common';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import type Redis from 'ioredis';
import { ConversationRepository } from '../repositories/conversation.repository';

/**
 * Cached identity resolved from Redis or the database.
 */
export interface ResolvedIdentity {
  contactId: string | null;
  conversationId: string | null;
}

/**
 * Key convention: `omni:identity:{platform}:{pageId}:{senderId}`
 *
 * IdentityService provides a Redis cache-aside pattern for quickly
 * resolving a platform sender to our internal Contact + Conversation IDs.
 *
 * Flow:
 *   1. Check Redis  → cache hit → return immediately
 *   2. Cache miss   → query MongoDB
 *   3. DB hit       → set Redis (TTL 24h) then return
 *   4. DB miss      → return nulls (caller will create new entities)
 *
 * Invalidation:
 *   Called when Contacts are merged or deleted so stale mappings
 *   don't point to non-existent documents.
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  /** Default cache TTL: 24 hours in seconds */
  private readonly CACHE_TTL = 60 * 60 * 24;

  constructor(
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    private readonly conversationRepo: ConversationRepository,
  ) {}

  // ────────────────────────── Public API ──────────────────────────

  /**
   * Resolve a platform sender to internal IDs.
   * Cache-aside: Redis first, then DB, then write-back.
   */
  async resolveIdentity(
    platform: string,
    pageId: string,
    senderId: string,
  ): Promise<ResolvedIdentity> {
    const key = this.buildKey(platform, pageId, senderId);

    // Step 1: Redis lookup
    const cached = await this.redis.get(key);
    if (cached) {
      try {
        return JSON.parse(cached) as ResolvedIdentity;
      } catch {
        // Corrupted cache entry — delete and fall through
        await this.redis.del(key);
      }
    }

    // Step 2: DB lookup — find the active conversation for this sender
    const conversation = await this.conversationRepo.findActiveByExternalId(
      '', // tenant is filtered elsewhere via tenant-filter plugin
      this.toSchemaChannelType(platform),
      pageId,
      senderId,
    );

    const identity: ResolvedIdentity = {
      contactId: conversation?.contactId ?? null,
      conversationId: conversation?.id ?? null,
    };

    // Step 3: Write-back into Redis (only if we found something useful)
    if (identity.conversationId) {
      await this.setCache(key, identity);
    }

    return identity;
  }

  /**
   * Resolve with a specific tenant (used in the refactored inbound flow).
   */
  async resolveIdentityForTenant(
    tenant: string,
    platform: string,
    pageId: string,
    senderId: string,
  ): Promise<ResolvedIdentity> {
    const key = this.buildKey(platform, pageId, senderId, tenant);
    const legacyKey = this.buildKey(platform, pageId, senderId);

    // Step 1: Redis lookup
    const cached = await this.redis.get(key);
    if (cached) {
      try {
        return JSON.parse(cached) as ResolvedIdentity;
      } catch {
        await this.redis.del(key);
      }
    }

    // Backward compatibility: migrate old non-tenant cache keys lazily.
    const legacyCached = await this.redis.get(legacyKey);
    if (legacyCached) {
      try {
        const parsed = JSON.parse(legacyCached) as ResolvedIdentity;
        await this.setCache(key, parsed);
        await this.redis.del(legacyKey);
        return parsed;
      } catch {
        await this.redis.del(legacyKey);
      }
    }

    // Step 2: DB lookup with explicit tenant
    const conversation = await this.conversationRepo.findActiveByExternalId(
      tenant,
      this.toSchemaChannelType(platform),
      pageId,
      senderId,
    );

    const identity: ResolvedIdentity = {
      contactId: conversation?.contactId ?? null,
      conversationId: conversation?.id ?? null,
    };

    // Step 3: Write-back
    if (identity.conversationId) {
      await this.setCache(key, identity);
    }

    return identity;
  }

  /**
   * Update the cached identity after a new Contact/Conversation is created.
   */
  async updateIdentity(
    platform: string,
    pageId: string,
    senderId: string,
    identity: ResolvedIdentity,
    tenant?: string,
  ): Promise<void> {
    const key = this.buildKey(platform, pageId, senderId, tenant);
    await this.setCache(key, identity);

    // Cleanup legacy key once tenant-aware key is used.
    if (tenant) {
      const legacyKey = this.buildKey(platform, pageId, senderId);
      await this.redis.del(legacyKey);
    }
  }

  /**
   * Invalidate cached identity — call this when:
   * - A Contact is merged into another Contact
   * - A Contact is deleted
   * - A Conversation is manually closed/removed
   */
  async invalidateIdentity(
    platform: string,
    pageId: string,
    senderId: string,
    tenant?: string,
  ): Promise<void> {
    const key = this.buildKey(platform, pageId, senderId, tenant);
    const keys = [key];
    if (tenant) {
      keys.push(this.buildKey(platform, pageId, senderId));
    }
    await this.redis.del(...keys);
    this.logger.log(`Invalidated identity cache: ${key}`);
  }

  /**
   * Bulk invalidation — useful when merging contacts that may have
   * multiple sender IDs across platforms.
   */
  async invalidateByPattern(pattern: string): Promise<void> {
    const keys = await this.redis.keys(`omni:identity:${pattern}`);
    if (keys.length > 0) {
      await this.redis.del(...keys);
      this.logger.log(
        `Invalidated ${keys.length} identity cache keys matching ${pattern}`,
      );
    }
  }

  // ────────────────────────── Internals ──────────────────────────

  private buildKey(
    platform: string,
    pageId: string,
    senderId: string,
    tenant?: string,
  ): string {
    return tenant
      ? `omni:identity:${tenant}:${platform}:${pageId}:${senderId}`
      : `omni:identity:${platform}:${pageId}:${senderId}`;
  }

  private async setCache(
    key: string,
    identity: ResolvedIdentity,
  ): Promise<void> {
    await this.redis.set(key, JSON.stringify(identity), 'EX', this.CACHE_TTL);
  }

  private toSchemaChannelType(type: string): string {
    const map: Record<string, string> = {
      facebook: 'Facebook',
      instagram: 'Instagram',
      zalo: 'Zalo',
      whatsapp: 'WhatsApp',
      livechat: 'LiveChat',
    };
    return map[type] ?? type;
  }
}
