import {
  Injectable,
  Logger,
  Inject,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Model } from 'mongoose';
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
import { AutoResolveService } from './auto-resolve.service';
import { AssignmentService } from './assignment.service';
import { AgentPresenceService } from './agent-presence.service';
import { ChannelsService } from '../../channels/channels.service';
import { TimelineQueryDto } from '../dto/timeline-query.dto';
import { TimelineResponseDto } from '../dto/timeline-response.dto';
import {
  ThreadIdentity,
  ThreadSessionSlice,
} from '../repositories/conversation.repository';
import { OMNI_MEDIA_CACHE_QUEUE } from '../queue/omni-media-queue.constants';
import type { MediaCacheJobData } from '../queue/media-cache.processor';
import { BotQueueService } from '../bot/bot-queue.service';
import { ConversationBotState } from '../domain/omni-conversation';

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

  /** Lock TTL: 5 seconds — well above typical DB operations (<500ms)
   *  but short enough to minimise contention when webhooks burst. */
  private readonly LOCK_TTL = 5_000;

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
    private readonly autoResolveService: AutoResolveService,
    private readonly assignmentService: AssignmentService,
    private readonly agentPresenceService: AgentPresenceService,
    private readonly channelsService: ChannelsService,
    private readonly botQueueService: BotQueueService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(OMNI_MEDIA_CACHE_QUEUE)
    private readonly mediaCacheQueue: Queue<MediaCacheJobData>,
    @InjectModel('GroupSchemaClass')
    private readonly groupModel: Model<any>,
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
    const idempotencyReserved = await this.redis.set(
      idemKey,
      '1',
      'EX',
      this.IDEM_TTL,
      'NX',
    );
    if (!idempotencyReserved) {
      this.logger.debug(`Idempotency hit — skipping message ${msgId}`);
      return;
    }

    // ── Step 2: Acquire distributed lock on sender ────────────
    const lockKey = `lock:inbound:${payload.tenantId}:${payload.channelId}:${payload.senderId}`;

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
      await this.redis.del(idemKey).catch(() => undefined);
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
      assignedAgentId: string | null;
    } | null = null;
    if (conversationId) {
      existing = await this.conversationRepo.findById(conversationId);

      if (!existing) {
        // Stale identity cache: conversation was deleted or doesn't exist.
        // Invalidate the cache entry and fall through to create a new one.
        this.logger.warn(
          `Stale identity cache: conversation ${conversationId} not found for sender ${payload.senderId} — invalidating and creating new`,
        );
        await this.identityService.invalidateIdentity(
          payload.channelType,
          payload.channelAccount,
          payload.externalConversationId,
          payload.tenantId,
        );
        conversationId = null;
        contactId = null;
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

          const reopened = await this.conversationRepo.reopenConversation(
            conversationId!,
          );

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

            // ── Auto-reassignment on reopen if agent is offline/unassigned ──
            const currentAgent = (reopened as any).assignedAgentId;
            if (!currentAgent) {
              await this.triggerAutoAssignment(
                payload,
                conversationId!,
                contactId ?? existing.contactId ?? null,
                'reopen_no_agent',
              );
            } else {
              // Check if the previous agent is still online
              const presence = await this.agentPresenceService.getPresence(
                payload.tenantId,
                currentAgent,
              );
              if (!presence || presence.status !== 'available') {
                this.logger.log(
                  `Reopened conversation ${conversationId}: previous agent ${currentAgent} is offline — triggering reassignment`,
                );
                await this.triggerAutoAssignment(
                  payload,
                  conversationId!,
                  contactId ?? existing.contactId ?? null,
                  'reopen_agent_offline',
                );
              }
            }

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
        const identityConfig = await this.getIdentityResolutionConfig(
          payload.tenantId,
        );
        if (identityConfig.autoCreateShadowContact) {
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
        } else {
          this.logger.debug(
            `Auto-create shadow contact disabled — skipping for conversation ${conversationId}`,
          );
        }
      }

      // ── Retry auto-assignment for existing open/pending conversations ──
      // If the conversation is still active but has no agent assigned,
      // retry auto-assignment. This covers cases where:
      //   - The original auto-assign failed (e.g. no agents online)
      //   - The conversation was unassigned manually
      //   - Agent disconnected and fallback didn't find a replacement
      if (
        existing &&
        conversationId &&
        (existing.status === 'open' || existing.status === 'pending')
      ) {
        const assignedAgent = existing.assignedAgentId;
        if (!assignedAgent) {
          this.logger.warn(
            `[AUTO-ASSIGN DEBUG] Existing conversation ${conversationId} is ${existing.status} but has NO agent — retrying auto-assignment`,
          );
          await this.triggerAutoAssignment(
            payload,
            conversationId,
            contactId ?? existing.contactId ?? null,
            'existing_unassigned',
          );
        } else {
          this.logger.debug(
            `Existing conversation ${conversationId} already assigned to agent ${assignedAgent} — skipping auto-assignment`,
          );
        }
      }
    }

    if (!conversationId) {
      // ── Step 3b: Eagerly fetch Facebook profile before creating conversation ──
      // This ensures BOTH the conversation AND shadow contact are created
      // with the real name/avatar from the start.
      // Respects the tenant's autoEnrichProfile setting (GDPR/PDPA compliance).
      let enrichedProfile: {
        name?: string;
        avatarUrl?: string;
        phone?: string;
      } = {};

      const identityResConfig = await this.getIdentityResolutionConfig(
        payload.tenantId,
      );

      if (
        identityResConfig.autoEnrichProfile &&
        payload.channelType === 'facebook' &&
        payload.metadata?.accessToken
      ) {
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
          this.logger.warn(
            `Profile pre-enrichment skipped: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      } else if (!identityResConfig.autoEnrichProfile) {
        this.logger.debug(
          `Auto-enrich profile disabled for tenant ${payload.tenantId} — skipping Facebook profile fetch`,
        );
      }

      // No active conversation -> maybe no contact either
      if (!contactId) {
        if (identityResConfig.autoCreateShadowContact) {
          contactId = await this.createShadowContact(payload, enrichedProfile);
        } else {
          this.logger.debug(
            `Auto-create shadow contact disabled — sender ${payload.senderId} will have no CRM contact`,
          );
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

      if (
        previousConv &&
        (previousConv.status === 'resolved' || previousConv.status === 'closed')
      ) {
        previousConversationId = previousConv.id;
        reopenCount = (previousConv.reopenCount ?? 0) + 1;
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
        bot: this.resolveInitialBotState(payload.metadata?.bot),
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

      // ── Step 6b: Schedule auto-resolve for new conversation ─────
      await this.autoResolveService.scheduleAutoResolve(
        payload.tenantId,
        conversationId,
      );

      // ── Step 6c: Auto-assign conversation to an agent ──────────
      await this.triggerAutoAssignment(
        payload,
        conversationId,
        contactId ?? null,
        previousConversationId ? 'reopen_new_session' : 'new_conversation',
        enrichedProfile,
      );

      // Profile enrichment already done eagerly before conversation creation (Step 3b above).
    }

    // ── Step 5a: Save the message immediately (with original media URL) ──
    // Media caching is done asynchronously via BullMQ to avoid blocking
    // the distributed lock during large file downloads.
    const message = await this.messageRepo.create({
      tenantId: payload.tenantId,
      conversationId: conversationId,
      senderId: payload.senderId,
      senderType: payload.senderType,
      direction: 'inbound',
      messageType: payload.messageType,
      content: payload.content,
      mediaUrl: payload.mediaUrl,
      mediaProxyUrl: undefined, // will be set async by MediaCacheProcessor
      status: 'delivered',
      metadata: payload.metadata,
      externalMessageId: payload.externalMessageId,
      platformMessageId: payload.externalMessageId, // dedup key
      providerTimestamp: payload.providerTimestamp ?? payload.timestamp,
    });

    // ── Step 5b: Enqueue async media cache job if media is present ──
    if (payload.mediaUrl) {
      await this.mediaCacheQueue.add(
        'cache-media',
        {
          tenantId: payload.tenantId,
          conversationId,
          messageId: message.id,
          mediaUrl: payload.mediaUrl,
          channelType: payload.channelType,
          mediaId: payload.metadata?.mediaId ?? payload.externalMessageId,
          accessToken: payload.metadata?.accessToken,
        },
        {
          // Use messageId as jobId for deduplication
          jobId: `media-${message.id}`,
        },
      );
      this.logger.debug(`Enqueued media cache job for message ${message.id}`);
    }

    // ── Step 5c: Update conversation summary ──────────────────
    const messagePreview = payload.content || `[${payload.messageType}]`;

    await this.conversationRepo.updateLastMessage(
      conversationId,
      messagePreview.substring(0, 200),
      payload.timestamp,
      payload.senderType,
    );

    // ── Step 5d-2: Track customer's last message time for reply window ──
    if (payload.senderType === 'customer') {
      await this.conversationRepo.updateLastCustomerMessageAt(
        conversationId,
        payload.providerTimestamp ?? payload.timestamp,
      );
    }

    // ── Step 5d: Reschedule auto-resolve timer (message resets the clock) ──
    await this.autoResolveService.rescheduleAutoResolve(
      payload.tenantId,
      conversationId,
    );

    // ── Step 7: Refresh processed marker TTL ────────────
    await this.redis.expire(idemKey, this.IDEM_TTL);

    this.logger.log(
      `Saved message ${payload.externalMessageId} ` +
        `to conversation ${conversationId}`,
    );

    // Emit persisted event with internal IDs for realtime broadcast
    this.eventEmitter.emit('omni.message.persisted', {
      ...payload,
      conversationId,
      messageId: payload.externalMessageId,
      internalMessageId: message.id,
    });

    await this.enqueueBotProcessingIfNeeded(
      payload,
      conversationId,
      message.id,
    );

    // ── Step 8: Business Hours / OOO Auto-Reply ────────────────
    await this.handleBusinessHoursCheck(payload, conversationId);
  }

  private resolveInitialBotState(
    botConfig: Record<string, any> | undefined,
  ): ConversationBotState {
    return {
      enabled: Boolean(botConfig?.enabled),
      provider: botConfig?.provider ?? 'typebot',
      flowId: botConfig?.flowId ?? botConfig?.publicId ?? null,
      sessionId: null,
      status: 'active',
      lastError: null,
      lockedAt: null,
    };
  }

  private async enqueueBotProcessingIfNeeded(
    payload: OmniPayload,
    conversationId: string,
    inboundMessageId: string,
  ): Promise<void> {
    if (payload.senderType !== 'customer') return;
    if (payload.messageType !== 'text') return;

    try {
      await this.botQueueService.enqueueInboundMessage({
        tenantId: payload.tenantId,
        org: payload.tenantId,
        conversationId,
        messageId: inboundMessageId,
        text: payload.content,
        channel: payload.channelType,
      });
    } catch (error) {
      this.logger.error(
        `Failed to enqueue bot job for inbound message ${inboundMessageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Auto-Assignment Engine
  // ────────────────────────────────────────────────────────────────

  /**
   * Trigger auto-assignment for a conversation.
   *
   * Flow:
   * 1. Load channel config → supportUserIds + supportGroupIds
   * 2. Resolve group members into individual user IDs
   * 3. Merge into a deduplicated agent pool
   * 4. Call AssignmentService with routing context + agent pool
   * 5. Emit assignment event for real-time broadcast + activity trail
   *
   * If the channel has autoAssignmentEnabled = false, skip assignment.
   * If supportUserIds AND supportGroupIds are both empty, use all online agents.
   */
  private async triggerAutoAssignment(
    payload: OmniPayload,
    conversationId: string,
    contactId: string | null,
    reason: string,
    enrichedProfile?: { name?: string; avatarUrl?: string; phone?: string },
  ): Promise<void> {
    try {
      this.logger.warn(
        `[AUTO-ASSIGN DEBUG] ═══════════════════════════════════════════════`,
      );
      this.logger.warn(
        `[AUTO-ASSIGN DEBUG] triggerAutoAssignment called for conversation=${conversationId}, reason=${reason}`,
      );
      this.logger.warn(
        `[AUTO-ASSIGN DEBUG] tenantId=${payload.tenantId}, channelType=${payload.channelType}, channelAccount=${payload.channelAccount}`,
      );

      // 1. Load channel config
      let channelConfig: Record<string, any> = {};
      try {
        const channel = await this.channelsService.findAnyByAccount(
          this.toSchemaChannelType(payload.channelType),
          payload.channelAccount,
        );
        this.logger.warn(
          `[AUTO-ASSIGN DEBUG] Channel lookup result: ${channel ? `found (id=${channel.id})` : 'NOT FOUND'}`,
        );
        this.logger.warn(
          `[AUTO-ASSIGN DEBUG] Channel full config: ${JSON.stringify(channel?.config ?? {}, null, 2)}`,
        );
        channelConfig = channel?.config ?? {};
      } catch (channelErr: any) {
        // Channel not found in DB — use defaults (assign from all agents)
        this.logger.warn(
          `[AUTO-ASSIGN DEBUG] Channel lookup EXCEPTION: ${channelErr.message}`,
        );
        this.logger.debug(
          `Channel not found for ${payload.channelType}/${payload.channelAccount} — using default routing`,
        );
      }

      // 2. Channel-first auto-assignment hierarchy
      //    - false  → SKIP immediately (channel override OFF)
      //    - true   → ALWAYS assign (channel override ON, bypasses global)
      //    - undefined → defer to global toggle (handled by AssignmentService)
      const channelAutoAssign = channelConfig.autoAssignmentEnabled;
      this.logger.warn(
        `[AUTO-ASSIGN DEBUG] channelConfig.autoAssignmentEnabled = ${JSON.stringify(channelAutoAssign)} (type: ${typeof channelAutoAssign})`,
      );

      if (channelAutoAssign === false) {
        this.logger.warn(
          `[AUTO-ASSIGN DEBUG] ❌ EARLY EXIT: Channel auto-assign is explicitly FALSE — skipping assignment`,
        );
        this.logger.log(
          `Auto-assignment explicitly disabled for channel ${payload.channelAccount} — skipping`,
        );
        return;
      }

      // 3. Build agent pool from channel's support config
      const supportUserIds: string[] = channelConfig.supportUserIds ?? [];
      const supportGroupIds: string[] = channelConfig.supportGroupIds ?? [];
      this.logger.warn(
        `[AUTO-ASSIGN DEBUG] supportUserIds=${JSON.stringify(supportUserIds)}, supportGroupIds=${JSON.stringify(supportGroupIds)}`,
      );

      let agentPool: string[] | undefined = undefined;
      if (supportUserIds.length > 0 || supportGroupIds.length > 0) {
        const groupMemberIds =
          await this.resolveGroupMembersForAssignment(supportGroupIds);
        this.logger.warn(
          `[AUTO-ASSIGN DEBUG] Resolved group members: ${JSON.stringify(groupMemberIds)}`,
        );
        const allSupportIds = [
          ...new Set([...supportUserIds, ...groupMemberIds]),
        ];
        agentPool = allSupportIds.length > 0 ? allSupportIds : undefined;

        this.logger.warn(
          `[AUTO-ASSIGN DEBUG] Final agent pool: ${JSON.stringify(agentPool)} (${allSupportIds.length} unique)`,
        );
      } else {
        this.logger.warn(
          `[AUTO-ASSIGN DEBUG] No support users/groups configured — agent pool is UNDEFINED (all online agents)`,
        );
      }

      // 4. Build routing context for rule evaluation
      const customerName =
        enrichedProfile?.name ??
        payload.metadata?.contactName ??
        payload.senderId;

      // 5. Call AssignmentService with channel override flag
      const routingContext = {
        channel: payload.channelType,
        tags: [],
        customerName,
        content: payload.content ?? '',
        time: this.getCurrentTimeHHmm(),
        segment: undefined,
      };
      this.logger.warn(
        `[AUTO-ASSIGN DEBUG] Calling AssignmentService.assignConversation with:`,
      );
      this.logger.warn(
        `[AUTO-ASSIGN DEBUG]   channelAutoAssignOverride=${JSON.stringify(channelAutoAssign)}`,
      );
      this.logger.warn(
        `[AUTO-ASSIGN DEBUG]   agentPool=${JSON.stringify(agentPool)}`,
      );
      this.logger.warn(
        `[AUTO-ASSIGN DEBUG]   contactId=${contactId}, senderId=${payload.senderId}`,
      );
      this.logger.warn(
        `[AUTO-ASSIGN DEBUG]   routingContext=${JSON.stringify(routingContext)}`,
      );

      const assignedAgentId = await this.assignmentService.assignConversation(
        payload.tenantId,
        conversationId,
        {
          agentPool,
          contactId,
          externalSenderId: payload.senderId,
          channelAutoAssignOverride: channelAutoAssign, // true | undefined
          routingContext,
          allowReassignment: reason === 'reopen_agent_offline',
        },
      );

      // 6. Emit assignment event for real-time broadcast
      if (assignedAgentId) {
        this.logger.warn(
          `[AUTO-ASSIGN DEBUG] ✅ SUCCESS: conversation ${conversationId} assigned to agent ${assignedAgentId}`,
        );
        this.eventEmitter.emit('omni.conversation.assigned', {
          tenantId: payload.tenantId,
          conversationId,
          agentId: assignedAgentId,
          oldAgentId: null,
          strategy: 'auto',
          reason,
        });
        this.logger.log(
          `Auto-assigned conversation ${conversationId} → agent ${assignedAgentId} (reason: ${reason})`,
        );
      } else {
        this.logger.warn(
          `[AUTO-ASSIGN DEBUG] ⚠️ NO ASSIGNMENT: conversation ${conversationId} goes to queue (reason: ${reason})`,
        );
        this.logger.log(
          `Conversation ${conversationId} goes to queue — no available agent (reason: ${reason})`,
        );
      }
      this.logger.warn(
        `[AUTO-ASSIGN DEBUG] ═══════════════════════════════════════════════`,
      );
    } catch (err: any) {
      // Auto-assignment failure must NOT block message processing
      this.logger.error(
        `Auto-assignment failed for conversation ${conversationId}: ${err.message}`,
        err.stack,
      );
    }
  }

  /**
   * Resolve group IDs to member user IDs from MongoDB.
   */
  private async resolveGroupMembersForAssignment(
    groupIds: string[],
  ): Promise<string[]> {
    if (groupIds.length === 0) return [];
    try {
      const groups = await this.groupModel
        .find({ _id: { $in: groupIds } })
        .lean()
        .exec();
      return groups.flatMap((g: any) =>
        (g.memberIds ?? g.members ?? []).map(String),
      );
    } catch (err: any) {
      this.logger.warn(`Failed to resolve group members: ${err.message}`);
      return [];
    }
  }

  /**
   * Get current time as HH:mm for routing rule time-based conditions.
   */
  private getCurrentTimeHHmm(): string {
    const now = new Date();
    return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
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
    agentId?: string | null;
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

      // Cancel any pending auto-resolve job for this conversation
      await this.autoResolveService.cancelAutoResolve(event.conversationId);

      const assignedAgentId =
        (await this.conversationRepo.findById(event.conversationId))
          ?.assignedAgentId ?? null;
      if (assignedAgentId) {
        await this.agentPresenceService.releaseConversation(
          event.tenantId,
          assignedAgentId,
        );
      }

      this.logger.log(
        `Invalidated identity cache for conversation ${event.conversationId} (${event.status})`,
      );
    }
  }

  /**
   * Map channel types to lowercase for schema storage.
   */
  private toSchemaChannelType(type: string): string {
    // Return lowercase to match schema enum and domain model
    return type.toLowerCase();
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
    enrichedProfile: { name?: string; avatarUrl?: string; phone?: string } = {},
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

      // ── Auto-merge check: does this sender match an existing contact? ──
      const identityConfig = await this.getIdentityResolutionConfig(
        payload.tenantId,
      );

      // ── Email-specific deduplication ────────────────────────────────────
      // For email channels, the senderId IS the email address.
      // Check if any existing contact already has this email in their
      // emails[] array or omniIdentities — prevents N contacts for one sender.
      if (payload.channelType === 'email' && payload.senderId) {
        const senderEmail = payload.senderId.toLowerCase();

        // Search by emails[] array first (most reliable)
        const existingByEmail = await this.contactsService.findByEmail(
          payload.tenantId,
          senderEmail,
        );
        if (existingByEmail) {
          // Ensure this contact has the Email omni identity
          try {
            await this.contactsService.mergeIdentity(existingByEmail.id, {
              channelType: this.toSchemaChannelType(payload.channelType),
              senderId: payload.senderId,
            });
          } catch {
            /* identity may already exist */
          }

          this.logger.log(
            `Reused existing contact ${existingByEmail.id} for email ${senderEmail}`,
          );
          return existingByEmail.id;
        }

        // Search by omniIdentities.senderId (catches earlier shadow contacts)
        const existingByIdentity = await this.contactsService.findBySenderId(
          payload.tenantId,
          this.toSchemaChannelType(payload.channelType),
          payload.senderId,
        );
        if (existingByIdentity) {
          // Add email to emails[] array if not already there
          try {
            await this.contactsService.addEmailIfMissing(
              existingByIdentity.id,
              senderEmail,
            );
          } catch {
            /* best effort */
          }

          this.logger.log(
            `Reused existing contact ${existingByIdentity.id} for sender ${senderEmail} (identity match)`,
          );
          return existingByIdentity.id;
        }
      }

      if (identityConfig.autoMergeShadowContact) {
        const phone = payload.metadata?.phone;
        const email =
          payload.metadata?.email ||
          (payload.channelType === 'email' ? payload.senderId : undefined);

        if (phone || email) {
          const duplicateResult = await this.contactsService.checkDuplicate({
            phones: phone,
            emails: email,
          });

          if (
            duplicateResult.isDuplicate &&
            duplicateResult.duplicates.length > 0
          ) {
            // Found an existing contact — merge identity into it instead of creating shadow
            const existingContact = duplicateResult.duplicates[0];

            try {
              await this.contactsService.mergeIdentity(existingContact.id, {
                channelType: this.toSchemaChannelType(payload.channelType),
                senderId: payload.senderId,
              });

              this.logger.log(
                `Auto-merged sender ${payload.senderId} into existing contact ${existingContact.id} ` +
                  `(matched by ${phone ? 'phone' : 'email'})`,
              );

              this.eventEmitter.emit('omni.contact.auto_merged', {
                tenantId: payload.tenantId,
                existingContactId: existingContact.id,
                senderId: payload.senderId,
                channelType: payload.channelType,
                matchedBy: phone ? 'phone' : 'email',
              });

              return existingContact.id;
            } catch (mergeErr: any) {
              this.logger.warn(
                `Auto-merge failed for sender ${payload.senderId}: ${mergeErr.message} — creating shadow instead`,
              );
            }
          }
        }
      }

      // ── Create shadow contact ─────────────────────────────────────────
      const displayName =
        enrichedProfile.name ??
        payload.metadata?.contactName ??
        payload.senderId;

      const nameParts = displayName.trim().split(/\s+/);
      const firstName = nameParts[0];
      const lastName =
        nameParts.length > 1 ? nameParts.slice(1).join(' ') : '(Omni)';

      // For email channels, populate the emails[] array for future dedup
      const emailsArray =
        payload.channelType === 'email' && payload.senderId
          ? [payload.senderId.toLowerCase()]
          : [];

      const contact = await this.contactsService.create({
        tenantId: payload.tenantId,
        firstName,
        lastName,
        emails: emailsArray,
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
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error(
        `Failed to create Shadow Contact for sender ${payload.senderId}: ${error.message}`,
        error.stack ?? JSON.stringify(err),
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
   * Load identity resolution configuration from tenant CRM settings.
   * Controls shadow contact creation, social profile enrichment, and auto-merge behavior.
   */
  private async getIdentityResolutionConfig(tenantId?: string): Promise<{
    autoCreateShadowContact: boolean;
    autoEnrichProfile: boolean;
    enrichmentDisclaimer: string;
    autoMergeShadowContact: boolean;
    autoMergeStrategy: string;
  }> {
    const defaults = {
      autoCreateShadowContact: true,
      autoEnrichProfile: true,
      enrichmentDisclaimer:
        'We collect publicly available profile information to improve your customer experience. You may request data deletion at any time.',
      autoMergeShadowContact: true,
      autoMergeStrategy: 'phone_email_match',
    };

    try {
      const config = await this.settingsService.getSetting(
        'omni_identity_resolution',
        tenantId,
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
      // Use channel-specific message if configured, otherwise fall back to generic.
      const oooMessage = this.businessHoursService.getChannelOOOMessage(
        oooConfig,
        payload.channelType,
      );
      if (oooMessage) {
        this.eventEmitter.emit('omni.ooo.auto_reply', {
          tenantId: payload.tenantId,
          conversationId,
          channelType: payload.channelType,
          channelAccount: payload.channelAccount,
          senderId: payload.senderId,
          message: oooMessage,
          externalConversationId: payload.externalConversationId,
        });

        this.logger.log(
          `Emitted OOO auto-reply for conversation ${conversationId} ` +
            `(channel: ${payload.channelType})`,
        );
      }
    } catch (err) {
      // Non-fatal — don't block message processing if OOO check fails
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Business hours check failed for conversation ${conversationId}: ${errorMessage}`,
      );
    }
  }
}
