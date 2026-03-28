import { Injectable, Logger, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import type Redis from 'ioredis';
import { OmniPayload } from '../domain/omni-payload';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { MediaProxyService } from './media-proxy.service';
import { IdentityService } from './identity.service';
import { RedisLockService } from '../../redis/redis-lock.service';
import { ContactsService } from '../../contacts/contacts.service';
import { FacebookAdapter } from '../adapters/facebook.adapter';

/**
 * ConversationService — listens to `omni.message.received` events and handles:
 *
 * 1. Idempotency check (Redis optimistic check)
 * 2. Distributed lock acquisition (per sender_id)
 * 3. Identity resolution (Redis cache-aside)
 * 4. Session management: finds or creates conversations
 *    - If current session is resolved/closed → creates NEW session with link
 * 5. Message persistence: saves each message to MongoDB
 * 6. Media caching: proxies expiring URLs via MediaProxyService
 * 7. Cache update: updates identity mapping in Redis
 */
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  /** TTL for the processed-message idempotency marker (1 hour) */
  private readonly IDEM_TTL = 60 * 60;

  /** Lock TTL: 10 seconds should be more than enough for the DB operations */
  private readonly LOCK_TTL = 10_000;

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly messageRepo: MessageRepository,
    private readonly mediaProxy: MediaProxyService,
    private readonly identityService: IdentityService,
    private readonly lockService: RedisLockService,
    private readonly contactsService: ContactsService,
    private readonly facebookAdapter: FacebookAdapter,
    private readonly eventEmitter: EventEmitter2,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Event handler: called when a normalized message arrives from any provider.
   *
   * Flow:
   *   1. Optimistic idempotency check (Redis)           — fast-reject duplicates
   *   2. Acquire distributed lock on sender_id          — prevent race conditions
   *   3. Resolve identity (Cache → DB)                  — find existing Contact/Conversation
   *   4. Create Contact/Conversation if needed           — within the lock
   *      - If existing conversation is resolved/closed → create NEW session
   *   5. Save message (unique index = DB-level guard)    — platformMessageId dedup
   *   6. Update identity cache                           — for future fast lookups
   *   7. Lock auto-released in finally block
   */
  @OnEvent('omni.message.received')
  async handleInboundMessage(payload: OmniPayload): Promise<void> {
    const msgId = payload.externalMessageId;

    // ── Step 1: Optimistic idempotency check (Redis) ──────────
    const idemKey = `omni:processed:${payload.tenantId}:${msgId}`;
    const alreadyProcessed = await this.redis.get(idemKey);
    if (alreadyProcessed) {
      this.logger.debug(`Idempotency hit — skipping message ${msgId}`);
      return;
    }

    // ── Step 2: Acquire distributed lock on sender ────────────
    const lockKey = `lock:omni:sender:${payload.senderId}`;

    try {
      await this.lockService.acquire(
        lockKey,
        this.LOCK_TTL,
        async () => {
          await this.processWithinLock(payload, idemKey);
        },
      );
    } catch (error: any) {
      // E11000 = duplicate key — another worker already saved this message
      if (error?.code === 11000) {
        this.logger.warn(
          `Duplicate message (race condition): ${msgId}`,
        );
        return;
      }
      this.logger.error(
        `Failed to handle inbound message: ${error.message}`,
        error.stack,
      );
      throw error; // re-throw so BullMQ can retry
    }
  }

  /**
   * Core processing logic — runs INSIDE the distributed lock.
   */
  private async processWithinLock(
    payload: OmniPayload,
    idemKey: string,
  ): Promise<void> {
    // ── Step 3: Resolve identity (Cache-aside) ────────────────
    const identity = await this.identityService.resolveIdentityForTenant(
      payload.tenantId,
      payload.channelType,
      payload.channelAccount,
      payload.externalConversationId,
    );

    // ── Step 4: Find or create conversation ───────────────────
    let conversationId = identity.conversationId;
    let contactId = identity.contactId;

    // ── Step 4a: Check if existing conversation is still active ──
    if (conversationId) {
      const existing = await this.conversationRepo.findById(conversationId);
      if (existing && (existing.status === 'resolved' || existing.status === 'closed')) {
        // Session is no longer active → force creation of a new session
        this.logger.log(
          `Existing conversation ${conversationId} is ${existing.status} ` +
            `— creating new session for sender ${payload.senderId}`,
        );
        // Keep the contactId from the previous session
        contactId = existing.customer?.contactId ?? contactId;
        // Set conversationId to null so a new one is created below
        conversationId = null;
      }
    }

    if (!conversationId) {
      // No active conversation -> maybe no contact either
      if (!contactId) {
        // Create Shadow Contact
        try {
          // Bypassing normal validation, simulate system creation
          const contact = await this.contactsService.create({
            firstName: payload.metadata.contactName ?? payload.senderId,
            lastName: '(Omni)',
            status: 'new',
            lifecycleStage: 'lead',
            source: this.toSchemaChannelType(payload.channelType),
            omniSenderId: payload.senderId,
            isShadow: true,
          } as any);
          contactId = contact.id;
          this.logger.log(`Created Shadow Contact ${contactId} for sender ${payload.senderId}`);
        } catch (err) {
          this.logger.error(`Failed to create Shadow Contact: ${err.message}`, err.stack);
        }
      }

      // ── Reopen tracking: find previous conversation if any ──
      let previousConversationId: string | null = null;
      let reopenCount = 0;

      const previousConv = await this.conversationRepo.findLastByExternalId(
        payload.tenantId,
        this.toSchemaChannelType(payload.channelType),
        payload.channelAccount,
        payload.externalConversationId,
      );

      if (previousConv && (previousConv.status === 'resolved' || previousConv.status === 'closed')) {
        previousConversationId = previousConv.id;
        reopenCount = (previousConv.reopenCount ?? 0) + 1;
      }

      // ── Step 3b: Eagerly fetch Facebook profile before creating conversation ──
      // This ensures the conversation is created with the real name/avatar from the start.
      let enrichedProfile: { name?: string; avatarUrl?: string; phone?: string } = {};
      if (payload.channelType === 'facebook' && payload.metadata?.accessToken) {
        try {
          const profile = await this.facebookAdapter.enrichProfile(
            payload.senderId,
            payload.metadata.accessToken,
          );
          if (profile.name && profile.name !== payload.senderId) {
            enrichedProfile = profile;
            this.logger.log(`Pre-enriched profile for ${payload.senderId}: ${profile.name}`);
          }
        } catch (err) {
          this.logger.warn(`Profile pre-enrichment skipped: ${err.message}`);
        }
      }

      // No active session → create a new one (with enriched profile)
      const conversation = await this.conversationRepo.create({
        tenant: payload.tenantId,
        channel: payload.channelId,
        channelAccount: payload.channelAccount,
        channelType: this.toSchemaChannelType(payload.channelType),
        externalId: payload.externalConversationId,
        customer: {
          externalId: payload.senderId,
          contactId: contactId ?? undefined,
          name: enrichedProfile.name ?? payload.metadata.contactName ?? payload.senderId,
          avatarUrl: enrichedProfile.avatarUrl ?? payload.metadata.avatarUrl ?? undefined,
          phone: enrichedProfile.phone ?? payload.metadata.phone ?? undefined,
        },
        status: 'open',
        lastMessage: payload.content,
        lastMessageAt: payload.timestamp,
        previousConversationId,
        reopenCount,
      } as any);

      conversationId = conversation.id;

      if (previousConversationId) {
        this.logger.log(
          `Created reopened conversation ${conversationId} ` +
            `(previous: ${previousConversationId}, reopenCount: ${reopenCount}) ` +
            `for customer ${payload.senderId} on ${payload.channelType}`,
        );

        // Emit reopen event for activity log + realtime
        this.eventEmitter.emit('omni.conversation.reopened', {
          tenantId: payload.tenantId,
          conversationId,
          previousConversationId,
          reopenCount,
          conversation, // Full object for frontend rendering
        });
      } else {
        this.logger.log(
          `Created new conversation ${conversationId} ` +
            `for customer ${payload.senderId} on ${payload.channelType}`,
        );
      }

      // Emit created event with full conversation for realtime broadcast
      this.eventEmitter.emit('omni.conversation.created', {
        tenantId: payload.tenantId,
        conversationId,
        channelType: payload.channelType,
        senderId: payload.senderId,
        conversation, // Full object for frontend rendering
      });

      // ── Step 6a: Update identity cache with new mapping ─────
      await this.identityService.updateIdentity(
        payload.channelType,
        payload.channelAccount,
        payload.externalConversationId,
        { contactId: contactId ?? payload.senderId, conversationId },
      );

      // Profile enrichment already done eagerly before conversation creation (Step 3b above).
      // The omni.conversation.customer_updated event/gateway path remains as a fallback
      // for cases where enrichment fails initially and retries later.
    }

    // ── Step 5a: Cache media if present ───────────────────────
    let mediaProxyUrl: string | undefined;
    if (payload.mediaUrl) {
      mediaProxyUrl = await this.mediaProxy.cacheMedia(
        payload.channelType,
        payload.mediaUrl,
        payload.metadata.mediaId ?? payload.externalMessageId,
        payload.metadata.accessToken,
      );
    }

    // ── Step 5b: Save the message ─────────────────────────────
    await this.messageRepo.create({
      tenant: payload.tenantId,
      conversation: conversationId,
      senderId: payload.senderId,
      senderType: payload.senderType,
      messageType: payload.messageType,
      content: payload.content,
      mediaUrl: payload.mediaUrl,
      mediaProxyUrl,
      status: 'delivered',
      metadata: payload.metadata,
      externalMessageId: payload.externalMessageId,
      platformMessageId: payload.externalMessageId, // dedup key
    });

    // ── Step 5c: Update conversation summary ──────────────────
    const messagePreview =
      payload.content ||
      `[${payload.messageType}]`;

    await this.conversationRepo.updateLastMessage(
      conversationId,
      messagePreview.substring(0, 200),
      payload.timestamp,
    );

    // ── Step 7: Mark message as processed in Redis ────────────
    await this.redis.set(idemKey, '1', 'EX', this.IDEM_TTL);

    this.logger.log(
      `Saved message ${payload.externalMessageId} ` +
        `to conversation ${conversationId}`,
    );

    // Emit persisted event with internal IDs for realtime broadcast
    this.eventEmitter.emit('omni.message.persisted', {
      ...payload,
      conversationId,
      messageId: payload.externalMessageId,
    });
  }

  // ────────────────────────────────────────────────────────────────
  // Event listeners for cache invalidation
  // ────────────────────────────────────────────────────────────────

  /**
   * When a conversation is resolved or closed, invalidate the identity cache
   * so the next inbound message creates a NEW session.
   */
  @OnEvent('omni.conversation.status_changed')
  async handleStatusChanged(event: {
    conversationId: string;
    status: string;
    channelType: string;
    channelAccount: string;
    externalConversationId: string;
  }): Promise<void> {
    if (event.status === 'resolved' || event.status === 'closed') {
      await this.identityService.invalidateIdentity(
        event.channelType,
        event.channelAccount,
        event.externalConversationId,
      );
      this.logger.log(
        `Invalidated identity cache for conversation ${event.conversationId} (${event.status})`,
      );
    }
  }

  /**
   * Map lowercase channel types to the schema enum values.
   */
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
