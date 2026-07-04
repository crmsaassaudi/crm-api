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
import { ConversationCommandService } from '../aggregate/conversation-command.service';

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
    @Inject(CHANNEL_ADAPTERS)
    private readonly adapters: Map<ChannelType, ChannelAdapter>,
    private readonly lifecycle: ConversationLifecycleService,
    private readonly orchestration: InboundOrchestrationService,
    private readonly shadowContactService: ShadowContactService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(OMNI_MEDIA_CACHE_QUEUE)
    private readonly mediaCacheQueue: Queue<MediaCacheJobData>,
    private readonly conversationCommandService: ConversationCommandService,
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
  @OnEvent(OmniEvents.MESSAGE_RECEIVED)
  async handleInboundMessage(payload: OmniPayload): Promise<void> {
    const msgId = this.buildMessageDedupId(payload);

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
        await this.processWithinLock(payload, idemKey, msgId);
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
    messageDedupId: string,
  ): Promise<void> {
    // ── Step 3: Resolve identity (Cache-aside) ────────────────
    const identity = await this.identityService.resolveIdentityForTenant(
      payload.tenantId,
      payload.channelType,
      payload.channelAccount,
      payload.externalConversationId,
    );

    let conversationId = identity.conversationId;
    let contactId = identity.contactId;

    // ── Step 4: Resolve existing or create new conversation ────
    const existing = await this.resolveExistingConversation(
      payload,
      conversationId,
    );

    if (existing) {
      const reopenResult = await this.handleConversationReopen(
        payload,
        existing,
        conversationId!,
      );
      conversationId = reopenResult.conversationId;
      contactId = reopenResult.contactId;

      await this.handleExistingContactSelfHeal(
        payload,
        existing,
        conversationId,
        contactId,
      );
      await this.retryAutoAssignmentIfNeeded(
        payload,
        existing,
        conversationId,
        contactId,
      );
    }

    if (!conversationId) {
      const enriched = await this.enrichProfileAndResolveContact(
        payload,
        contactId,
      );
      contactId = enriched.contactId;

      const conversation = await this.createNewConversation(
        payload,
        contactId,
        enriched.profile,
      );
      conversationId = conversation.id;

      await this.identityService.updateIdentity(
        payload.channelType,
        payload.channelAccount,
        payload.externalConversationId,
        { contactId: contactId ?? null, conversationId },
        payload.tenantId,
      );

      await this.triggerInitialAutoAssignment(
        payload,
        conversationId,
        contactId,
      );
    }

    // ── Aggregate: Enqueue CUSTOMER_MESSAGE command ──────────────────
    await this.conversationCommandService.enqueueCustomerMessage(
      conversationId,
      payload.tenantId,
      payload,
      messageDedupId,
      idemKey,
    );

    this.logger.log(
      `Enqueued CUSTOMER_MESSAGE for ${messageDedupId} → conversation ${conversationId}`,
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

  private async resolveExistingConversation(
    payload: OmniPayload,
    conversationId: string | null,
  ) {
    if (!conversationId) return null;

    const existing = await this.conversationRepo.findById(conversationId);
    if (!existing) {
      this.logger.warn(
        `Stale identity cache: conversation ${conversationId} not found — invalidating`,
      );
      await this.identityService.invalidateIdentity(
        payload.channelType,
        payload.channelAccount,
        payload.externalConversationId,
        payload.tenantId,
      );
      return null;
    }

    if (existing.tenantId !== payload.tenantId) {
      throw new BadRequestException(
        `Cross-tenant conversation mapping detected for sender ${payload.senderId}`,
      );
    }

    return existing;
  }

  private async handleConversationReopen(
    payload: OmniPayload,
    existing: any,
    conversationId: string,
  ): Promise<{ conversationId: string | null; contactId: string | null }> {
    if (existing.status !== 'resolved' && existing.status !== 'closed') {
      return { conversationId, contactId: existing.contactId };
    }

    const config = await this.lifecycle.getSessionLifecycleConfig();
    const reopenWindow = config.reopenWindowHours ?? 24;
    const resolvedAt =
      existing.resolvedAt ?? existing.closedAt ?? existing.updatedAt;
    const hoursSinceResolved = resolvedAt
      ? (Date.now() - new Date(resolvedAt).getTime()) / (1000 * 60 * 60)
      : Infinity;

    if (reopenWindow > 0 && hoursSinceResolved <= reopenWindow) {
      this.logger.log(
        `Reopening conversation ${conversationId} within window (${hoursSinceResolved.toFixed(1)}h)`,
      );
      const reopened =
        await this.conversationRepo.reopenConversation(conversationId);
      if (reopened) {
        await this.identityService.updateIdentity(
          payload.channelType,
          payload.channelAccount,
          payload.externalConversationId,
          { contactId: existing.contactId, conversationId },
          payload.tenantId,
        );
        this.emitReopenEvents(payload, existing, reopened);
        await this.handleReassignmentOnReopen(
          payload,
          conversationId,
          existing.contactId,
          reopened.assignedAgentId,
        );
        existing.__assignmentHandledOnReopen = true;
        return { conversationId, contactId: existing.contactId };
      }
    }

    this.logger.log(
      `Reopen window expired for ${conversationId} — forcing new session`,
    );
    return { conversationId: null, contactId: existing.contactId };
  }

  private emitReopenEvents(payload: OmniPayload, existing: any, reopened: any) {
    this.eventEmitter.emit(OmniEvents.CONVERSATION_REOPENED, {
      tenantId: payload.tenantId,
      conversationId: reopened.id,
      previousConversationId: null,
      reopenCount: reopened.reopenCount,
      conversation: reopened,
      isReopenedSession: true,
    });
    this.eventEmitter.emit(OmniEvents.CONVERSATION_STATUS_CHANGED, {
      tenantId: payload.tenantId,
      conversationId: reopened.id,
      status: 'open',
      oldStatus: existing.status,
      agentId: null,
      reason: 'customer_replied_within_reopen_window',
      channelType: payload.channelType,
      channelAccount: payload.channelAccount,
      externalConversationId: payload.externalConversationId,
    });
  }

  private async handleReassignmentOnReopen(
    payload: OmniPayload,
    conversationId: string,
    contactId: string | null,
    currentAgent: string | null,
  ) {
    if (!currentAgent) {
      await this.orchestration.triggerAutoAssignment(
        payload,
        conversationId,
        contactId,
        'reopen_no_agent',
      );
    } else {
      await this.orchestration.checkAndReassignIfNeeded(
        payload,
        conversationId,
        currentAgent,
        contactId,
      );
    }
  }

  private async handleExistingContactSelfHeal(
    payload: OmniPayload,
    existing: any,
    conversationId: string | null,
    contactId: string | null,
  ) {
    if (conversationId && !contactId) {
      const config =
        await this.shadowContactService.getIdentityResolutionConfig(
          payload.tenantId,
        );
      if (config.autoCreateShadowContact) {
        const createdId =
          await this.shadowContactService.createShadowContact(payload);
        if (createdId) {
          await this.conversationRepo.updateContactId(
            conversationId,
            createdId,
          );
          await this.identityService.updateIdentity(
            payload.channelType,
            payload.channelAccount,
            payload.externalConversationId,
            { contactId: createdId, conversationId },
            payload.tenantId,
          );
        }
      }
    }
  }

  private async retryAutoAssignmentIfNeeded(
    payload: OmniPayload,
    existing: any,
    conversationId: string | null,
    contactId: string | null,
  ) {
    if (
      !conversationId ||
      (existing.status !== 'open' && existing.status !== 'pending')
    )
      return;

    const botIsActive =
      existing.bot?.enabled === true && existing.bot?.status === 'active';
    if (botIsActive || existing.__assignmentHandledOnReopen) return;

    if (!existing.assignedAgentId) {
      await this.orchestration.triggerAutoAssignment(
        payload,
        conversationId,
        contactId,
        'existing_unassigned',
      );
    }
  }

  private async enrichProfileAndResolveContact(
    payload: OmniPayload,
    contactId: string | null,
  ) {
    const config = await this.shadowContactService.getIdentityResolutionConfig(
      payload.tenantId,
    );
    let profile: any = {};

    if (config.autoEnrichProfile) {
      profile = await this.fetchExternalProfile(payload);
    }

    if (contactId && !profile.name) {
      const enriched = await this.shadowContactService.enrichProfileFromContact(
        contactId,
        profile,
      );
      profile = enriched || profile;
    }

    if (!contactId && config.autoCreateShadowContact) {
      contactId = await this.shadowContactService.createShadowContact(
        payload,
        profile,
      );
    }

    return { contactId, profile };
  }

  private async fetchExternalProfile(payload: OmniPayload) {
    const adapter = this.adapters.get(payload.channelType);
    if (adapter?.enrichProfile && payload.metadata?.accessToken) {
      try {
        return await adapter.enrichProfile(
          payload.senderId,
          payload.metadata.accessToken,
        );
      } catch (err) {
        this.logger.warn(
          `Profile enrichment skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (payload.metadata?.contactName) {
      return { name: payload.metadata.contactName };
    }
    return {};
  }

  private async createNewConversation(
    payload: OmniPayload,
    contactId: string | null,
    profile: any,
  ) {
    const previousConv = await this.conversationRepo.findLastByExternalId(
      payload.tenantId,
      this.lifecycle.toSchemaChannelType(payload.channelType),
      payload.channelAccount,
      payload.externalConversationId,
    );

    const isReopen =
      previousConv &&
      (previousConv.status === 'resolved' || previousConv.status === 'closed');
    const reopenCount = isReopen ? (previousConv!.reopenCount ?? 0) + 1 : 0;

    const conversation = await this.conversationRepo.create({
      tenantId: payload.tenantId,
      channelId: payload.channelId,
      channelAccount: payload.channelAccount,
      channelType: this.lifecycle.toSchemaChannelType(payload.channelType),
      externalId: payload.externalConversationId,
      contactId: contactId ?? null,
      customer: {
        externalId: payload.senderId,
        name: profile.name ?? payload.metadata.contactName ?? payload.senderId,
        avatarUrl: profile.avatarUrl ?? payload.metadata.avatarUrl ?? undefined,
        phone: profile.phone ?? payload.metadata.phone ?? undefined,
        email: profile.email ?? payload.metadata?.email ?? undefined,
      },
      status: 'open',
      lastMessage: payload.content,
      lastMessageAt: payload.timestamp,
      previousConversationId: isReopen ? previousConv!.id : null,
      reopenCount,
      bot: await this.orchestration.resolveInitialBotState(
        payload.tenantId,
        this.lifecycle.toSchemaChannelType(payload.channelType),
        payload.channelAccount,
      ),
    } as any);

    this.emitConversationCreationEvents(
      payload,
      conversation,
      isReopen ? previousConv!.id : null,
      reopenCount,
    );
    return conversation;
  }

  private emitConversationCreationEvents(
    payload: OmniPayload,
    conversation: any,
    prevId: string | null,
    reopenCount: number,
  ) {
    if (prevId) {
      this.eventEmitter.emit(OmniEvents.CONVERSATION_REOPENED, {
        tenantId: payload.tenantId,
        conversationId: conversation.id,
        previousConversationId: prevId,
        reopenCount,
        conversation,
      });
    }
    this.eventEmitter.emit(OmniEvents.CONVERSATION_CREATED, {
      tenantId: payload.tenantId,
      conversationId: conversation.id,
      channelType: payload.channelType,
      senderId: payload.senderId,
      conversation,
      correlationId: payload.correlationId,
    });
  }

  private async triggerInitialAutoAssignment(
    payload: OmniPayload,
    conversationId: string,
    contactId: string | null,
  ) {
    const isBotFirst = await this.orchestration.isBotFirstActive(
      payload.tenantId,
      this.lifecycle.toSchemaChannelType(payload.channelType),
      payload.channelAccount,
    );

    if (isBotFirst) {
      this.logger.log(
        `[BOT-FIRST] Deferring auto-assignment for ${conversationId}`,
      );
    } else {
      await this.orchestration.triggerAutoAssignment(
        payload,
        conversationId,
        contactId,
        'new_conversation',
      );
    }
  }

  private toFingerprintDate(value: Date | string | undefined): string {
    if (!value) {
      return '';
    }

    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }
}
