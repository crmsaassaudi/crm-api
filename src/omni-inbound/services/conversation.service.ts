import {
  Injectable,
  Logger,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import type Redis from 'ioredis';
import { OmniPayload } from '../domain/omni-payload';
import { OmniEvents } from '../domain/omni-events';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { MediaProxyService } from './media-proxy.service';
import { IdentityService } from './identity.service';
import { RedisLockService } from '../../redis/redis-lock.service';
import {
  ChannelAdapter,
  CHANNEL_ADAPTERS,
} from '../adapters/channel-adapter.interface';
import { ChannelType } from '../domain/omni-payload';
import { InboundOrchestrationService } from './inbound-orchestration.service';
import { ShadowContactService } from './shadow-contact.service';
import { ConversationLifecycleService } from './conversation-lifecycle.service';
import { OMNI_MEDIA_CACHE_QUEUE } from '../queue/omni-media-queue.constants';
import type { MediaCacheJobData } from '../queue/media-cache.processor';

/**
 * ConversationService â€” listens to `omni.message.received` events and handles:
 *
 * 1. Idempotency check (Redis optimistic check)
 * 2. Distributed lock acquisition (per sender_id)
 * 3. Identity resolution (Redis cache-aside)
 * 4. Session management: finds or creates conversations
 *    - If current session is resolved/closed:
 *      a) Within reopen window â†’ reopen existing session
 *      b) Past reopen window â†’ create NEW session with link
 * 5. Message persistence: saves each message to MongoDB
 * 6. Media caching: proxies expiring URLs via MediaProxyService
 * 7. Cache update: updates identity mapping in Redis
 */
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  /** TTL for the processed-message idempotency marker (1 hour) */
  private readonly IDEM_TTL = 60 * 60;

  /** Lock TTL: 5 seconds â€” well above typical DB operations (<500ms)
   *  but short enough to minimise contention when webhooks burst. */
  private readonly LOCK_TTL = 5_000;

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly messageRepo: MessageRepository,
    private readonly mediaProxy: MediaProxyService,
    private readonly identityService: IdentityService,
    private readonly lockService: RedisLockService,
    @Inject(CHANNEL_ADAPTERS)
    private readonly adapters: Map<ChannelType, ChannelAdapter>,
    private readonly lifecycle: ConversationLifecycleService,
    private readonly orchestration: InboundOrchestrationService,
    private readonly shadowContactService: ShadowContactService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(OMNI_MEDIA_CACHE_QUEUE)
    private readonly mediaCacheQueue: Queue<MediaCacheJobData>,
  ) {}

  /**
   * Event handler: called when a normalized message arrives from any provider.
   *
   * Flow:
   *   1. Optimistic idempotency check (Redis)           â€” fast-reject duplicates
   *   2. Acquire distributed lock on sender_id          â€” prevent race conditions
   *   3. Resolve identity (Cache â†’ DB)                  â€” find existing Contact/Conversation
   *   4. Create Contact/Conversation if needed           â€” within the lock
   *      - If existing conversation is resolved/closed â†’ create NEW session
   *   5. Save message (unique index = DB-level guard)    â€” platformMessageId dedup
   *   6. Update identity cache                           â€” for future fast lookups
   *   7. Lock auto-released in finally block
   */
  @OnEvent(OmniEvents.MESSAGE_RECEIVED)
  async handleInboundMessage(payload: OmniPayload): Promise<void> {
    const msgId = this.buildMessageDedupId(payload);

    // â”€â”€ Step 1: Optimistic idempotency check (Redis) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const idemKey = `omni:processed:${payload.tenantId}:${msgId}`;
    const idempotencyReserved = await this.redis.set(
      idemKey,
      '1',
      'EX',
      this.IDEM_TTL,
      'NX',
    );
    if (!idempotencyReserved) {
      this.logger.debug(`Idempotency hit â€” skipping message ${msgId}`);
      return;
    }

    // â”€â”€ Step 2: Acquire distributed lock on sender â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const lockKey = `lock:inbound:${payload.tenantId}:${payload.channelId}:${payload.senderId}`;

    try {
      await this.lockService.acquire(lockKey, this.LOCK_TTL, async () => {
        await this.processWithinLock(payload, idemKey, msgId);
      });
    } catch (error: any) {
      // E11000 = duplicate key â€” another worker already saved this message
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
   * Core processing logic â€” runs INSIDE the distributed lock.
   */
  private async processWithinLock(
    payload: OmniPayload,
    idemKey: string,
    messageDedupId: string,
  ): Promise<void> {
    // â”€â”€ Step 3: Resolve identity (Cache-aside) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const identity = await this.identityService.resolveIdentityForTenant(
      payload.tenantId,
      payload.channelType,
      payload.channelAccount,
      payload.externalConversationId,
    );

    // â”€â”€ Step 4: Find or create conversation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let conversationId = identity.conversationId;
    let contactId = identity.contactId;

    // â”€â”€ Step 4a: Check if existing conversation is still active â”€â”€
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
          `Stale identity cache: conversation ${conversationId} not found for sender ${payload.senderId} â€” invalidating and creating new`,
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
        // â”€â”€ Reopen Window Check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Fetch tenant session lifecycle config
        const lifecycleConfig = await this.lifecycle.getSessionLifecycleConfig();
        const reopenWindowHours = lifecycleConfig.reopenWindowHours ?? 24;

        // MED-04: resolvedAt fallback chain â€” closedAt > updatedAt.
        // updatedAt can be bumped by unrelated writes (tag, note, assignment),
        // causing the reopen window to be inaccurately extended.
        const resolvedAt =
          (existing as any).resolvedAt ??
          (existing as any).closedAt ??
          (existing as any).updatedAt;
        if (!(existing as any).resolvedAt) {
          this.logger.warn(
            `Conversation ${conversationId} has no resolvedAt â€” using ${(existing as any).closedAt ? 'closedAt' : 'updatedAt'} as fallback`,
          );
        }
        const hoursSinceResolved = resolvedAt
          ? (Date.now() - new Date(resolvedAt).getTime()) / (1000 * 60 * 60)
          : Infinity;

        if (reopenWindowHours > 0 && hoursSinceResolved <= reopenWindowHours) {
          // WITHIN reopen window â†’ reopen existing session
          this.logger.log(
            `Conversation ${conversationId} is ${existing.status} but within reopen window ` +
              `(${hoursSinceResolved.toFixed(1)}h / ${reopenWindowHours}h) â€” reopening`,
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

            this.eventEmitter.emit(OmniEvents.CONVERSATION_REOPENED, {
              tenantId: payload.tenantId,
              conversationId,
              previousConversationId: null,
              reopenCount: reopened.reopenCount,
              conversation: reopened,
              isReopenedSession: true, // distinguish from new-session reopen
            });

            this.eventEmitter.emit(OmniEvents.CONVERSATION_STATUS_CHANGED, {
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
            // P0 fix: track that assignment was already handled here so the
            // 'existing_unassigned' retry block below does not fire a second
            // time reading a stale existing.assignedAgentId snapshot.
            let assignmentTriggeredOnReopen = false;
            const currentAgent = (reopened as any).assignedAgentId;
            if (!currentAgent) {
              await this.orchestration.triggerAutoAssignment(
                payload,
                conversationId!,
                contactId ?? existing.contactId ?? null,
                'reopen_no_agent',
              );
              assignmentTriggeredOnReopen = true;
            } else {
              // Check if the previous agent is still online.
              // checkAndReassignIfNeeded fires triggerAutoAssignment internally
              // when the agent is gone — count that as handled too.
              await this.orchestration.checkAndReassignIfNeeded(
                payload,
                conversationId!,
                currentAgent,
                contactId ?? existing.contactId ?? null,
              );
              assignmentTriggeredOnReopen = true;
            }

            // Keep contactId from the reopened session
            contactId = existing.contactId ?? contactId;
            // conversationId stays the same — don't create a new one

            // Signal to the existing_unassigned block below that assignment
            // was already handled so it does not double-fire.
            if (assignmentTriggeredOnReopen) {
              (existing as any).__assignmentHandledOnReopen = true;
            }
          }
        } else {
          // OUTSIDE reopen window â†’ force creation of a new session
          this.logger.log(
            `Existing conversation ${conversationId} is ${existing.status} ` +
              `and reopen window expired (${hoursSinceResolved.toFixed(1)}h > ${reopenWindowHours}h) ` +
              `â€” creating new session for sender ${payload.senderId}`,
          );
          // Keep the contactId from the previous session
          contactId = existing.contactId ?? contactId;
          // Set conversationId to null so a new one is created below
          conversationId = null;
        }
      }

      // Self-heal old data: active conversation exists but contact was never linked.
      if (existing && conversationId && !contactId) {
        const identityConfig =
          await this.shadowContactService.getIdentityResolutionConfig(
            payload.tenantId,
          );
        if (identityConfig.autoCreateShadowContact) {
          const createdContactId =
            await this.shadowContactService.createShadowContact(payload);
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
            `Auto-create shadow contact disabled â€” skipping for conversation ${conversationId}`,
          );
        }
      }

      // â”€â”€ Retry auto-assignment for existing open/pending conversations â”€â”€
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
        // P0 fix: skip if assignment was already triggered in the reopen
        // branch above. existing.assignedAgentId is a stale snapshot taken
        // before that assignment committed — a second call here would race.
        if ((existing as any).__assignmentHandledOnReopen) {
          this.logger.debug(
            `Skipping existing_unassigned retry — assignment already handled on reopen for conversation ${conversationId}`,
          );
        } else {
          const assignedAgent = existing.assignedAgentId;
          if (!assignedAgent) {
            this.logger.debug(
              `[AUTO-ASSIGN] Existing conversation ${conversationId} is ${existing.status} but has NO agent — retrying auto-assignment`,
            );
            await this.orchestration.triggerAutoAssignment(
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
    }

    if (!conversationId) {
      // â”€â”€ Step 3b: Eagerly enrich profile before creating conversation â”€â”€
      // Delegates to the channel adapter's enrichProfile() method if available.
      // This ensures BOTH the conversation AND shadow contact are created
      // with the real name/avatar from the start.
      // Respects the tenant's autoEnrichProfile setting (GDPR/PDPA compliance).
      let enrichedProfile: {
        name?: string;
        avatarUrl?: string;
        phone?: string;
      } = {};

      const identityResConfig =
        await this.shadowContactService.getIdentityResolutionConfig(
          payload.tenantId,
        );

      if (identityResConfig.autoEnrichProfile) {
        const adapter = this.adapters.get(payload.channelType);
        if (adapter?.enrichProfile && payload.metadata?.accessToken) {
          // Channel supports profile API (Facebook, Instagram, etc.)
          try {
            const profile = await adapter.enrichProfile(
              payload.senderId,
              payload.metadata.accessToken,
            );
            if (profile.name && profile.name !== payload.senderId) {
              enrichedProfile = profile;
              this.logger.log(
                `Pre-enriched ${payload.channelType} profile for ${payload.senderId}: ${profile.name}`,
              );
            }
          } catch (err) {
            this.logger.warn(
              `${payload.channelType} profile pre-enrichment skipped: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        } else if (payload.metadata?.contactName) {
          // Channel provides name in webhook payload (WhatsApp, Telegram, etc.)
          const contactName = payload.metadata.contactName;
          if (contactName !== payload.senderId) {
            enrichedProfile = { name: contactName };
            this.logger.log(
              `Pre-enriched ${payload.channelType} profile for ${payload.senderId}: ${contactName}`,
            );
          }
        }
      } else {
        this.logger.debug(
          `Auto-enrich profile disabled for tenant ${payload.tenantId} â€” skipping profile fetch`,
        );
      }

      // No active conversation -> maybe no contact either
      if (!contactId) {
        if (identityResConfig.autoCreateShadowContact) {
          contactId = await this.shadowContactService.createShadowContact(
            payload,
            enrichedProfile,
          );
        } else {
          this.logger.debug(
            `Auto-create shadow contact disabled â€” sender ${payload.senderId} will have no CRM contact`,
          );
        }
      }

      // â”€â”€ Reopen tracking: find previous conversation if any â”€â”€
      let previousConversationId: string | null = null;
      let reopenCount = 0;

      const previousConv = await this.conversationRepo.findLastByExternalId(
        payload.tenantId,
        this.lifecycle.toSchemaChannelType(payload.channelType),
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

      // No active session â†’ create a new one (with enriched profile)
      const conversation = await this.conversationRepo.create({
        tenantId: payload.tenantId,
        channelId: payload.channelId,
        channelAccount: payload.channelAccount,
        channelType: this.lifecycle.toSchemaChannelType(payload.channelType),
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
        bot: await this.orchestration.resolveInitialBotState(
          payload.tenantId,
          this.lifecycle.toSchemaChannelType(payload.channelType),
          payload.channelAccount,
        ),
      } as any);

      conversationId = conversation.id;

      if (previousConversationId) {
        this.logger.log(
          `Created reopened conversation ${conversationId} ` +
            `(previous: ${previousConversationId}, reopenCount: ${reopenCount}) ` +
            `for customer ${payload.senderId} on ${payload.channelType}`,
        );

        // Emit reopen event for activity log + realtime
        this.eventEmitter.emit(OmniEvents.CONVERSATION_REOPENED, {
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
      this.eventEmitter.emit(OmniEvents.CONVERSATION_CREATED, {
        tenantId: payload.tenantId,
        conversationId,
        channelType: payload.channelType,
        senderId: payload.senderId,
        conversation, // Full object for frontend rendering
        correlationId: payload.correlationId, // T07: propagate trace ID
      });

      // â”€â”€ Step 6a: Update identity cache with new mapping â”€â”€â”€â”€â”€
      await this.identityService.updateIdentity(
        payload.channelType,
        payload.channelAccount,
        payload.externalConversationId,
        { contactId: contactId ?? null, conversationId },
        payload.tenantId,
      );

      // F-10 fix: removed redundant rescheduleAutoResolve here (was Step 6b).
      // The authoritative reschedule runs at Step 5d (after message persistence),
      // which correctly resets the timer once the message is durably stored.
      // Two calls per new conversation doubled BullMQ Redis operations under load.

      // â”€â”€ Step 6c: Auto-assign conversation to an agent â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      await this.orchestration.triggerAutoAssignment(
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
    const { message, inserted } =
      await this.messageRepo.upsertInboundByExternalId({
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
        externalMessageId: messageDedupId,
        platformMessageId: messageDedupId, // dedup key
        providerTimestamp: payload.providerTimestamp ?? payload.timestamp,
      });

    if (!inserted) {
      await this.redis.expire(idemKey, this.IDEM_TTL);
      this.logger.debug(
        `Duplicate inbound message ${messageDedupId} already persisted; skipping side effects`,
      );
      return;
    }

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
          mediaId: payload.metadata?.mediaId ?? messageDedupId,
          accessToken: payload.metadata?.accessToken,
        },
        {
          // Use messageId as jobId for deduplication
          jobId: `media-${message.id}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 500 },
        },
      );
      this.logger.debug(`Enqueued media cache job for message ${message.id}`);
    } else if (payload.metadata?.media?.storageKey) {
      // ── Livechat visitor uploads: file already on S3 ──────────────
      // VisitorUploadService uploads base64 → S3 before the message enters
      // the pipeline, so there's no external mediaUrl to cache. We resolve
      // a presigned download URL from the storageKey so agent CRM can
      // render the media immediately.
      try {
        const presignedUrl = await this.mediaProxy.getPresignedUrl(
          payload.metadata.media.storageKey,
          3600,
        );
        await this.messageRepo.updateMediaProxyUrl(
          message.id,
          presignedUrl,
        );
        this.logger.debug(
          `Resolved presigned URL for visitor upload: message ${message.id}`,
        );
      } catch (err: any) {
        this.logger.warn(
          `Failed to resolve presigned URL for visitor upload ${message.id}: ${err?.message}`,
        );
      }
    }

    // â”€â”€ Step 5c: Update conversation summary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const messagePreview = payload.content || `[${payload.messageType}]`;

    await this.conversationRepo.updateLastMessage(
      conversationId,
      messagePreview.substring(0, 200),
      payload.timestamp,
      payload.senderType,
    );

    // â”€â”€ Step 5d-2: Track customer's last message time for reply window â”€â”€
    if (payload.senderType === 'customer') {
      await this.conversationRepo.updateLastCustomerMessageAt(
        conversationId,
        payload.providerTimestamp ?? payload.timestamp,
      );
    }

    // â”€â”€ Step 5d: Reschedule auto-resolve timer (message resets the clock) â”€â”€
    await this.orchestration.rescheduleAutoResolve(
      payload.tenantId,
      conversationId,
    );

    // â”€â”€ Step 7: Refresh processed marker TTL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    await this.redis.expire(idemKey, this.IDEM_TTL);

    this.logger.log(
      `Saved message ${messageDedupId} ` + `to conversation ${conversationId}`,
    );

    // Emit persisted event with internal IDs for realtime broadcast
    this.eventEmitter.emit(OmniEvents.MESSAGE_PERSISTED, {
      ...payload,
      conversationId,
      messageId: messageDedupId,
      internalMessageId: message.id,
    });

    await this.orchestration.enqueueBotProcessingIfNeeded(
      payload,
      conversationId,
      message.id,
    );

    // â”€â”€ Step 8: Business Hours / OOO Auto-Reply â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // F-11 fix: fetch current assignedAgentId so OOO is suppressed when an
    // agent has already been successfully routed to this conversation.
    const currentConv = await this.conversationRepo.findById(conversationId);
    await this.orchestration.handleBusinessHoursCheck(
      payload,
      conversationId,
      currentConv?.assignedAgentId ?? null,
    );
  }

  private buildMessageDedupId(payload: OmniPayload): string {
    const externalMessageId = payload.externalMessageId?.trim();
    if (externalMessageId) {
      return externalMessageId;
    }

    const fingerprint = [
      payload.tenantId,
      payload.channelType,
      payload.channelId,
      payload.channelAccount,
      payload.externalConversationId,
      payload.senderId,
      this.toFingerprintDate(payload.providerTimestamp ?? payload.timestamp),
      payload.messageType,
      payload.content ?? '',
      payload.mediaUrl ?? '',
    ].join('|');

    return `synthetic:${createHash('sha256').update(fingerprint).digest('hex')}`;
  }



  // ────────────────────────────────────────────────────────────────
  // Private Helpers
  // ────────────────────────────────────────────────────────────────

  private toFingerprintDate(value: Date | string | undefined): string {
    if (!value) {
      return '';
    }

    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }
}
