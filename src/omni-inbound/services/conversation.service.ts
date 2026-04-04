import {
  Injectable,
  Logger,
  Inject,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
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
import { TenantsService } from '../../tenants/tenants.service';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { BusinessHoursService } from './business-hours.service';
import { TimelineQueryDto } from '../dto/timeline-query.dto';
import { TimelineResponseDto } from '../dto/timeline-response.dto';
import {
  ThreadIdentity,
  ThreadSessionSlice,
} from '../repositories/conversation.repository';

/**
 * ConversationService — listens to `omni.message.received` events and handles:
 *
 * 1. Idempotency check (Redis optimistic check)
 * 2. Distributed lock acquisition (per sender_id)
 * 3. Identity resolution (Redis cache-aside)
 * 4. Session management: finds or creates conversations
 *    - If current session is resolved/closed:
 *      a) Within reopen window → reopen existing session
 *      b) Past reopen window → create NEW session with link
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
    private readonly tenantsService: TenantsService,
    private readonly settingsService: CrmSettingsService,
    private readonly businessHoursService: BusinessHoursService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async getConversationTimeline(params: {
    tenantId: string;
    conversationId: string;
    query: TimelineQueryDto;
  }): Promise<TimelineResponseDto> {
    const conversation = await this.conversationRepo.findById(
      params.conversationId,
    );
    if (!conversation || conversation.tenantId !== params.tenantId) {
      throw new NotFoundException(
        `Conversation ${params.conversationId} not found`,
      );
    }

    const sessionLimit = this.parsePositiveInt(
      params.query.sessionLimit,
      5,
      20,
    );
    const messageLimit = this.parsePositiveInt(
      params.query.messageLimit,
      50,
      100,
    );

    const thread: ThreadIdentity = {
      tenantId: conversation.tenantId,
      channelType: conversation.channelType,
      channelAccount: conversation.channelAccount,
      externalId: conversation.externalConversationId,
    };

    const anchorCursor = {
      createdAt: conversation.createdAt,
      id: conversation.id,
    };

    const pastCursor = this.parseCursor(
      params.query.pastCursorCreatedAt,
      params.query.pastCursorId,
    );
    const futureCursor = this.parseCursor(
      params.query.futureCursorCreatedAt,
      params.query.futureCursorId,
    );

    let past: ThreadSessionSlice = {
      sessions: [],
      hasMore: false,
      cursor: null,
    };
    let future: ThreadSessionSlice = {
      sessions: [],
      hasMore: false,
      cursor: null,
    };

    if (!pastCursor && !futureCursor) {
      const around = await this.conversationRepo.findThreadSessionsAroundAnchor(
        {
          thread,
          anchor: anchorCursor,
          pastLimit: sessionLimit,
          futureLimit: sessionLimit,
        },
      );
      past = around.past;
      future = around.future;
    } else {
      if (pastCursor) {
        past = await this.conversationRepo.findPastSessionsByCursor({
          ...thread,
          cursor: pastCursor,
          limit: sessionLimit,
        });
      }
      if (futureCursor) {
        future = await this.conversationRepo.findFutureSessionsByCursor({
          ...thread,
          cursor: futureCursor,
          limit: sessionLimit,
        });
      }
    }

    const timelineSessions = [
      ...past.sessions,
      conversation,
      ...future.sessions,
    ];

    const messageMap =
      await this.messageRepo.findByConversationIdsChronological(
        timelineSessions.map((session) => session.id),
        messageLimit,
      );

    const toSessionBlock = (session: any) => {
      const fullName = session.resolvedByAgent
        ? [session.resolvedByAgent.firstName, session.resolvedByAgent.lastName]
            .filter(Boolean)
            .join(' ')
            .trim() || null
        : null;

      const sessionMessages = messageMap[session.id] ?? [];
      const lastMessage = sessionMessages[sessionMessages.length - 1] ?? null;

      return {
        id: session.id,
        status: session.status,
        createdAt: session.createdAt,
        resolvedAt: session.resolvedAt,
        resolvedByAgentId: session.resolvedByAgentId,
        resolvedByAgentName: fullName,
        resolvedByAgentEmail: session.resolvedByAgent?.email ?? null,
        resolveReason: session.resolveReason,
        resolveNote: session.resolveNote,
        resolveSource: session.resolveSource,
        lastMessage: session.lastMessage,
        messages: {
          data: sessionMessages,
          hasMore: sessionMessages.length >= messageLimit,
          cursor: lastMessage
            ? {
                createdAt: lastMessage.createdAt,
                id: lastMessage.id,
              }
            : null,
        },
      };
    };

    return {
      pastSessions: past.sessions.map(toSessionBlock),
      anchorSession: toSessionBlock(conversation),
      futureSessions: future.sessions.map(toSessionBlock),
      hasMorePast: past.hasMore,
      hasMoreFuture: future.hasMore,
      pastCursor: past.cursor,
      futureCursor: future.cursor,
    };
  }

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
      await this.lockService.acquire(lockKey, this.LOCK_TTL, async () => {
        await this.processWithinLock(payload, idemKey);
      });
    } catch (error: any) {
      // E11000 = duplicate key — another worker already saved this message
      if (error?.code === 11000) {
        this.logger.warn(`Duplicate message (race condition): ${msgId}`);
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
    let existing: {
      tenantId: string;
      status: string;
      contactId: string | null;
    } | null = null;
    if (conversationId) {
      existing = await this.conversationRepo.findById(conversationId);

      if (!existing) {
        throw new NotFoundException(
          `Conversation ${conversationId} not found for sender ${payload.senderId}`,
        );
      } else if (existing.tenantId !== payload.tenantId) {
        throw new BadRequestException(
          `Cross-tenant conversation mapping detected for sender ${payload.senderId}`,
        );
      }

      if (
        existing &&
        (existing.status === 'resolved' || existing.status === 'closed')
      ) {
        // ── Reopen Window Check ──────────────────────────────────
        // Fetch tenant session lifecycle config
        const lifecycleConfig = await this.getSessionLifecycleConfig();
        const reopenWindowHours = lifecycleConfig.reopenWindowHours ?? 24;

        // Check if the conversation was resolved within the reopen window
        const resolvedAt =
          (existing as any).resolvedAt ?? (existing as any).updatedAt;
        const hoursSinceResolved = resolvedAt
          ? (Date.now() - new Date(resolvedAt).getTime()) / (1000 * 60 * 60)
          : Infinity;

        if (reopenWindowHours > 0 && hoursSinceResolved <= reopenWindowHours) {
          // WITHIN reopen window → reopen existing session
          this.logger.log(
            `Conversation ${conversationId} is ${existing.status} but within reopen window ` +
              `(${hoursSinceResolved.toFixed(1)}h / ${reopenWindowHours}h) — reopening`,
          );

          const reopened =
            await this.conversationRepo.reopenConversation(conversationId);

          if (reopened) {
            // Update identity cache so future messages go to this conversation
            await this.identityService.updateIdentity(
              payload.channelType,
              payload.channelAccount,
              payload.externalConversationId,
              {
                contactId: existing.contactId ?? contactId,
                conversationId,
              },
              payload.tenantId,
            );

            this.eventEmitter.emit('omni.conversation.reopened', {
              tenantId: payload.tenantId,
              conversationId,
              previousConversationId: null,
              reopenCount: reopened.reopenCount,
              conversation: reopened,
              isReopenedSession: true, // distinguish from new-session reopen
            });

            this.eventEmitter.emit('omni.conversation.status_changed', {
              tenantId: payload.tenantId,
              conversationId,
              status: 'open',
              oldStatus: existing.status,
              agentId: null,
              reason: 'customer_replied_within_reopen_window',
              channelType: payload.channelType,
              channelAccount: payload.channelAccount,
              externalConversationId: payload.externalConversationId,
            });

            // Keep contactId from the reopened session
            contactId = existing.contactId ?? contactId;
            // conversationId stays the same — don't create a new one
          }
        } else {
          // OUTSIDE reopen window → force creation of a new session
          this.logger.log(
            `Existing conversation ${conversationId} is ${existing.status} ` +
              `and reopen window expired (${hoursSinceResolved.toFixed(1)}h > ${reopenWindowHours}h) ` +
              `— creating new session for sender ${payload.senderId}`,
          );
          // Keep the contactId from the previous session
          contactId = existing.contactId ?? contactId;
          // Set conversationId to null so a new one is created below
          conversationId = null;
        }
      }

      // Self-heal old data: active conversation exists but contact was never linked.
      if (existing && conversationId && !contactId) {
        const createdContactId = await this.createShadowContact(payload);
        if (createdContactId) {
          contactId = createdContactId;
          await this.conversationRepo.updateContactId(
            conversationId,
            contactId,
          );
          await this.identityService.updateIdentity(
            payload.channelType,
            payload.channelAccount,
            payload.externalConversationId,
            { contactId, conversationId },
            payload.tenantId,
          );
          this.logger.log(
            `Linked Shadow Contact ${contactId} to existing conversation ${conversationId}`,
          );
        }
      }
    }

    if (!conversationId) {
      // No active conversation -> maybe no contact either
      if (!contactId) {
        contactId = await this.createShadowContact(payload);
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

      if (
        previousConv &&
        (previousConv.status === 'resolved' || previousConv.status === 'closed')
      ) {
        previousConversationId = previousConv.id;
        reopenCount = (previousConv.reopenCount ?? 0) + 1;
      }

      // ── Step 3b: Eagerly fetch Facebook profile before creating conversation ──
      // This ensures the conversation is created with the real name/avatar from the start.
      let enrichedProfile: {
        name?: string;
        avatarUrl?: string;
        phone?: string;
      } = {};
      if (payload.channelType === 'facebook' && payload.metadata?.accessToken) {
        try {
          const profile = await this.facebookAdapter.enrichProfile(
            payload.senderId,
            payload.metadata.accessToken,
          );
          if (profile.name && profile.name !== payload.senderId) {
            enrichedProfile = profile;
            this.logger.log(
              `Pre-enriched profile for ${payload.senderId}: ${profile.name}`,
            );
          }
        } catch (err) {
          this.logger.warn(`Profile pre-enrichment skipped: ${err.message}`);
        }
      }

      // No active session → create a new one (with enriched profile)
      const conversation = await this.conversationRepo.create({
        tenantId: payload.tenantId,
        channelId: payload.channelId,
        channelAccount: payload.channelAccount,
        channelType: this.toSchemaChannelType(payload.channelType),
        externalId: payload.externalConversationId,
        contactId: contactId ?? null,
        customer: {
          externalId: payload.senderId,
          name:
            enrichedProfile.name ??
            payload.metadata.contactName ??
            payload.senderId,
          avatarUrl:
            enrichedProfile.avatarUrl ??
            payload.metadata.avatarUrl ??
            undefined,
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
        { contactId: contactId ?? null, conversationId },
        payload.tenantId,
      );

      // Profile enrichment already done eagerly before conversation creation (Step 3b above).
    }

    // ── Step 5a: Cache media if present ───────────────────────
    let mediaProxyUrl: string | undefined;
    if (payload.mediaUrl) {
      mediaProxyUrl = await this.mediaProxy.cacheMedia(
        payload.tenantId,
        payload.channelType,
        payload.mediaUrl,
        payload.metadata.mediaId ?? payload.externalMessageId,
        payload.metadata.accessToken,
      );
    }

    // ── Step 5b: Save the message ─────────────────────────────
    await this.messageRepo.create({
      tenantId: payload.tenantId,
      conversationId: conversationId,
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
      providerTimestamp: payload.providerTimestamp ?? payload.timestamp,
    });

    // ── Step 5c: Update conversation summary ──────────────────
    const messagePreview = payload.content || `[${payload.messageType}]`;

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

    // ── Step 8: Business Hours / OOO Auto-Reply ────────────────
    await this.handleBusinessHoursCheck(payload, conversationId);
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
    tenantId: string;
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
        event.tenantId,
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

  private parsePositiveInt(
    value: string | undefined,
    fallback: number,
    max: number,
  ): number {
    const parsed = Number.parseInt(value ?? `${fallback}`, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      return fallback;
    }
    return Math.min(parsed, max);
  }

  private parseCursor(
    createdAt?: string,
    id?: string,
  ): { createdAt: Date; id: string } | null {
    if (!createdAt && !id) {
      return null;
    }
    if (!createdAt || !id) {
      throw new BadRequestException('Cursor requires both createdAt and id');
    }

    const parsedDate = new Date(createdAt);
    if (Number.isNaN(parsedDate.getTime())) {
      throw new BadRequestException(
        'Cursor createdAt must be a valid ISO date',
      );
    }

    return { createdAt: parsedDate, id };
  }

  private async createShadowContact(
    payload: OmniPayload,
  ): Promise<string | null> {
    try {
      const tenant = await this.tenantsService.findById(payload.tenantId);
      const systemActorId = tenant?.ownerId ?? null;

      if (!systemActorId) {
        this.logger.warn(
          `Skipping shadow contact creation for sender ${payload.senderId}: ` +
            `tenant ${payload.tenantId} has no ownerId`,
        );
      }

      // Bypassing normal validation, simulate system creation.
      const contact = await this.contactsService.create({
        tenantId: payload.tenantId,
        firstName: payload.metadata.contactName ?? payload.senderId,
        lastName: '(Omni)',
        status: 'new',
        lifecycleStage: 'lead',
        source: this.toSchemaChannelType(payload.channelType),
        omniIdentities: [
          {
            channelType: this.toSchemaChannelType(payload.channelType),
            senderId: payload.senderId,
          },
        ],
        isShadow: true,
        createdById: systemActorId ?? undefined,
        updatedById: systemActorId ?? undefined,
      } as any);

      this.logger.log(
        `Created Shadow Contact ${contact.id} for sender ${payload.senderId}`,
      );

      return contact.id;
    } catch (err) {
      this.logger.error(
        `Failed to create Shadow Contact for sender ${payload.senderId}: ${err.message}`,
        err.stack ?? JSON.stringify(err),
      );
      return null;
    }
  }

  /**
   * Load session lifecycle configuration from tenant CRM settings.
   * Falls back to sensible defaults if not configured.
   */
  private async getSessionLifecycleConfig(): Promise<{
    reopenWindowHours: number;
    autoResolveTimeoutHours: number;
    autoResolveEnabled: boolean;
    oooAutoReplyEnabled: boolean;
    oooMessage: string;
    oooSetPending: boolean;
  }> {
    const defaults = {
      reopenWindowHours: 24,
      autoResolveTimeoutHours: 48,
      autoResolveEnabled: true,
      oooAutoReplyEnabled: false,
      oooMessage:
        'Thank you for your message! Our team is currently offline. We will get back to you during business hours.',
      oooSetPending: true,
    };

    try {
      const config = await this.settingsService.getSetting(
        'omni_session_lifecycle',
      );
      return config ? { ...defaults, ...config } : defaults;
    } catch {
      return defaults;
    }
  }

  /**
   * Check if this message arrived outside business hours.
   * If so, optionally:
   *   - Send an out-of-office auto-reply message
   *   - Set the conversation status to 'pending'
   */
  private async handleBusinessHoursCheck(
    payload: OmniPayload,
    conversationId: string,
  ): Promise<void> {
    try {
      const withinHours = await this.businessHoursService.isWithinBusinessHours(
        payload.tenantId,
      );

      if (withinHours) {
        return; // Normal business hours — nothing to do
      }

      const oooConfig = await this.businessHoursService.getOOOConfig(
        payload.tenantId,
      );

      if (!oooConfig.oooAutoReplyEnabled) {
        return; // OOO is disabled — nothing to do
      }

      // Set conversation to pending if configured
      if (oooConfig.oooSetPending) {
        await this.conversationRepo.updateStatus(conversationId, 'pending');
        this.logger.log(
          `Set conversation ${conversationId} to pending (outside business hours)`,
        );
      }

      // Emit an event for the OOO auto-reply message.
      // The outbound service or gateway can listen to this and send
      // the actual reply through the appropriate channel.
      if (oooConfig.oooMessage) {
        this.eventEmitter.emit('omni.ooo.auto_reply', {
          tenantId: payload.tenantId,
          conversationId,
          channelType: payload.channelType,
          channelAccount: payload.channelAccount,
          senderId: payload.senderId,
          message: oooConfig.oooMessage,
          externalConversationId: payload.externalConversationId,
        });

        this.logger.log(
          `Emitted OOO auto-reply for conversation ${conversationId} ` +
            `(channel: ${payload.channelType})`,
        );
      }
    } catch (err) {
      // Non-fatal — don't block message processing if OOO check fails
      this.logger.warn(
        `Business hours check failed for conversation ${conversationId}: ${err.message}`,
      );
    }
  }
}
