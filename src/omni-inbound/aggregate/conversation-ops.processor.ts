import { Processor, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Connection } from 'mongoose';
import { Job, Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Inject } from '@nestjs/common';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import type Redis from 'ioredis';

import { BaseTenantConsumer } from '../../queue/base-tenant.consumer';
import { RedisLockService } from '../../redis/redis-lock.service';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { InboundOrchestrationService } from '../services/inbound-orchestration.service';
import { MediaProxyService } from '../services/media-proxy.service';
import { OmniEvents } from '../domain/omni-events';

import {
  ConversationCommand,
  CustomerMessagePayload,
  BotReplyPayload,
  AssignAgentPayload,
  ChangeStatusPayload,
  UpdateBotStatePayload,
} from './conversation-command.types';
import {
  CONV_OPS_QUEUE,
  CONV_OPS_DLQ,
  CONV_OPS_LOCK_PREFIX,
  CONV_OPS_LOCK_TTL_MS,
  CONV_OPS_MAX_ATTEMPTS,
} from './conversation-ops.constants';
import {
  ProcessedOperationSchemaClass,
  ProcessedOperationDocument,
} from '../infrastructure/persistence/document/entities/processed-operation.schema';
import {
  OutboxEventSchemaClass,
  OutboxEventDocument,
} from '../infrastructure/persistence/document/entities/outbox-event.schema';

import { OutboundService } from '../../omni-outbound/outbound.service';
import { AgentPresenceService } from '../services/agent-presence.service';
import { AssignmentService } from '../services/assignment.service';

/**
 * ConversationOpsProcessor — the Aggregate Root processor.
 *
 * Processes commands from the conversation-ops queue sequentially
 * per conversation using Redis distributed locks.
 *
 * Responsibilities:
 * 1. Acquire per-conversation lock (sequential within same conversation)
 * 2. Idempotency check (MongoDB processed_operations collection)
 * 3. Allocate sequence number (MongoDB atomic $inc)
 * 4. Execute command (save message, update aggregate, save outbox events)
 * 5. Publish outbox events after commit
 * 6. Move to DLQ after max retries
 */
@Processor(CONV_OPS_QUEUE)
export class ConversationOpsProcessor extends BaseTenantConsumer<ConversationCommand> {
  protected readonly logger = new Logger(ConversationOpsProcessor.name);
  protected readonly cls: ClsService;

  constructor(
    cls: ClsService,
    private readonly lockService: RedisLockService,
    private readonly conversationRepo: ConversationRepository,
    private readonly messageRepo: MessageRepository,
    private readonly orchestration: InboundOrchestrationService,
    private readonly mediaProxy: MediaProxyService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(ProcessedOperationSchemaClass.name)
    private readonly processedOpsModel: Model<ProcessedOperationDocument>,
    @InjectModel(OutboxEventSchemaClass.name)
    private readonly outboxModel: Model<OutboxEventDocument>,
    @InjectQueue(CONV_OPS_DLQ) private readonly dlqQueue: Queue,
    private readonly outboundService: OutboundService,
    private readonly agentPresenceService: AgentPresenceService,
    private readonly assignmentService: AssignmentService,
  ) {
    super();
    this.cls = cls;
  }

  protected async handle(job: Job<ConversationCommand>): Promise<void> {
    const cmd = job.data;
    const lockKey = `${CONV_OPS_LOCK_PREFIX}${cmd.conversationId}`;

    try {
      await this.lockService.acquire(lockKey, CONV_OPS_LOCK_TTL_MS, async () => {
        await this.processCommand(cmd);
      });
    } catch (error) {
      // Move to DLQ after max attempts
      if (job.attemptsMade >= CONV_OPS_MAX_ATTEMPTS - 1) {
        const dlqPayload = {
          command: cmd,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          failedAt: new Date().toISOString(),
          attempts: job.attemptsMade + 1,
        };
        await this.dlqQueue.add('dead-letter', dlqPayload);
        this.logger.error(
          `[CONV-OPS] Moved to DLQ after ${job.attemptsMade + 1} attempts: ` +
            `op=${cmd.operationId} type=${cmd.type} conv=${cmd.conversationId}`,
        );
        // Emit DLQ event for external alerting (Slack, Loki, Prometheus)
        this.eventEmitter.emit('conv-ops.dlq.entered', dlqPayload);
        return; // Don't re-throw — prevent infinite retry
      }
      throw error; // BullMQ retries with exponential backoff
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Inline Execution (Hybrid Pattern — synchronous callers)
  // ────────────────────────────────────────────────────────────────────

  /**
   * Execute a command synchronously within the aggregate lock.
   *
   * Production pattern (Zendesk, HubSpot, Salesforce):
   * Controller operations need synchronous response with updated document.
   * Instead of enqueuing to BullMQ and waiting (anti-pattern under load),
   * we acquire the SAME per-conversation Redis lock and execute the handler
   * inline. This guarantees sequential consistency with queue-based
   * operations (CUSTOMER_MESSAGE, BOT_REPLY) without the queue overhead.
   *
   * Returns the updated conversation document for the controller response.
   */
  async executeInline(cmd: ConversationCommand): Promise<any> {
    const lockKey = `${CONV_OPS_LOCK_PREFIX}${cmd.conversationId}`;

    return this.lockService.acquire(lockKey, CONV_OPS_LOCK_TTL_MS, async () => {
      await this.processCommand(cmd);
      // Return the updated conversation for synchronous response
      return this.conversationRepo.findById(cmd.conversationId);
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // Command Router
  // ────────────────────────────────────────────────────────────────────

  private async processCommand(cmd: ConversationCommand): Promise<void> {
    const startTime = Date.now();

    // Propagate correlation context for downstream structured logs
    this.cls.set('correlationId', cmd.operationId);
    this.cls.set('conversationId', cmd.conversationId);

    // 1. Idempotency check
    const alreadyProcessed = await this.checkIdempotency(cmd);
    if (alreadyProcessed) return;

    // 2. Allocate sequence (inside lock — monotonic per conversation)
    const sequence = await this.conversationRepo.getNextSequence(
      cmd.conversationId,
    );

    // 3. Route to handler
    switch (cmd.type) {
      case 'CUSTOMER_MESSAGE':
        await this.handleCustomerMessage(
          cmd as ConversationCommand & { payload: CustomerMessagePayload },
          sequence,
        );
        break;
      case 'BOT_REPLY':
        await this.handleBotReply(
          cmd as ConversationCommand & { payload: BotReplyPayload },
          sequence,
        );
        break;
      case 'ASSIGN_AGENT':
        await this.handleAssignAgent(
          cmd as ConversationCommand & { payload: AssignAgentPayload },
        );
        break;
      case 'CHANGE_STATUS':
        await this.handleChangeStatus(
          cmd as ConversationCommand & { payload: ChangeStatusPayload },
        );
        break;
      case 'UPDATE_BOT_STATE':
        await this.handleUpdateBotState(
          cmd as ConversationCommand & { payload: UpdateBotStatePayload },
        );
        break;
      default:
        this.logger.warn(`[CONV-OPS] Unknown command type: ${cmd.type}`);
    }

    // 4. Mark processed
    await this.markProcessed(cmd);

    // 5. Duration metrics
    const duration = Date.now() - startTime;
    this.logger.log(
      `[CONV-OPS] ✓ ${cmd.type} op=${cmd.operationId} ` +
        `conv=${cmd.conversationId} duration=${duration}ms`,
    );
    if (duration > 5000) {
      this.logger.warn(
        `[CONV-OPS] SLOW_OPERATION: ${cmd.type} took ${duration}ms ` +
          `op=${cmd.operationId} conv=${cmd.conversationId} tenant=${cmd.tenantId}`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // CUSTOMER_MESSAGE Handler
  // ────────────────────────────────────────────────────────────────────

  private async handleCustomerMessage(
    cmd: ConversationCommand & { payload: CustomerMessagePayload },
    sequence: number,
  ): Promise<void> {
    const { omniPayload: payload, messageDedupId, idemKey } = cmd.payload;

    // Save the inbound message
    const { message, inserted } =
      await this.messageRepo.upsertInboundByExternalId({
        tenantId: payload.tenantId,
        conversationId: cmd.conversationId,
        senderId: payload.senderId,
        senderType: payload.senderType,
        direction: 'inbound',
        messageType: payload.messageType,
        content: payload.content,
        mediaUrl: payload.mediaUrl,
        mediaProxyUrl: undefined,
        status: 'delivered',
        metadata: payload.metadata,
        externalMessageId: messageDedupId,
        platformMessageId: messageDedupId,
        providerTimestamp: payload.providerTimestamp ?? payload.timestamp,
      });

    if (!inserted) {
      await this.redis.expire(idemKey, 3600);
      this.logger.debug(
        `[CONV-OPS] Duplicate inbound message ${messageDedupId} — skipping`,
      );
      return;
    }

    // Handle media: livechat visitor uploads (file already on S3)
    if (
      !payload.mediaUrl &&
      payload.metadata?.media?.storageKey
    ) {
      try {
        const presignedUrl = await this.mediaProxy.getPresignedUrl(
          payload.metadata.media.storageKey,
          3600,
        );
        payload.mediaProxyUrl = presignedUrl;
      } catch (err: any) {
        this.logger.warn(
          `Failed to resolve presigned URL for visitor upload ${message.id}: ${err?.message}`,
        );
      }
    }

    // Update conversation aggregate (single atomic write)
    const preview = (payload.content || `[${payload.messageType}]`).substring(
      0,
      200,
    );
    const msgTimestamp = payload.providerTimestamp ?? payload.timestamp;

    await this.conversationRepo.atomicUpdate(cmd.conversationId, {
      $set: {
        lastMessageId: message.id,
        lastMessagePreview: preview,
        lastMessageType: payload.messageType,
        lastMessageAt: msgTimestamp,
        lastMessageSenderType: payload.senderType,
        // Backward compat: dual-write old field
        lastMessage: preview,
        // Track customer's last message time for reply window
        ...(payload.senderType === 'customer'
          ? { lastCustomerMessageAt: msgTimestamp }
          : {}),
      },
      $inc: {
        messageCount: 1,
        // Only increment unread for customer messages
        ...(payload.senderType === 'customer' ? { unreadCount: 1 } : {}),
      },
    });

    // Expire idempotency key
    await this.redis.expire(idemKey, 3600);

    this.logger.log(
      `[CONV-OPS] Saved message ${messageDedupId} seq=${sequence} conv=${cmd.conversationId}`,
    );

    // Save outbox event + publish
    const persistedEvent = {
      ...payload,
      conversationId: cmd.conversationId,
      messageId: messageDedupId,
      internalMessageId: message.id,
    };

    await this.saveAndPublishOutboxEvent(
      cmd.conversationId,
      cmd.tenantId,
      OmniEvents.MESSAGE_PERSISTED,
      persistedEvent,
    );

    // Enqueue media cache job if needed (async, non-blocking)
    if (payload.mediaUrl) {
      this.eventEmitter.emit('conv-ops.media-cache-needed', {
        tenantId: payload.tenantId,
        conversationId: cmd.conversationId,
        messageId: message.id,
        mediaUrl: payload.mediaUrl,
        channelType: payload.channelType,
        mediaId: payload.metadata?.mediaId ?? messageDedupId,
        accessToken: payload.metadata?.accessToken,
      });
    }

    // Reschedule auto-resolve timer (non-critical — degraded UX if fails)
    await this.orchestration
      .rescheduleAutoResolve(payload.tenantId, cmd.conversationId)
      .catch((err) =>
        this.logOperationWarning(cmd, 'rescheduleAutoResolve', err),
      );

    // Read conversation state ONCE for downstream checks (bot state, business hours).
    const conversationSnapshot = await this.conversationRepo.findById(
      cmd.conversationId,
    );

    // Enqueue bot processing — CRITICAL: if this fails, customer won't get
    // a bot reply. Re-throw so BullMQ retries the entire command.
    // Message persistence is idempotent (upsertInboundByExternalId), so retry is safe.
    await this.orchestration.enqueueBotProcessingIfNeeded(
      payload,
      cmd.conversationId,
      message.id,
      payload.providerTimestamp ?? payload.timestamp,
      conversationSnapshot, // reuse snapshot — avoid redundant findById
    );

    // Business hours check (non-critical — OOO message can be missed)
    await this.orchestration
      .handleBusinessHoursCheck(
        payload,
        cmd.conversationId,
        conversationSnapshot?.assignedAgentId ?? null,
      )
      .catch((err) =>
        this.logOperationWarning(cmd, 'businessHoursCheck', err),
      );
  }

  // ────────────────────────────────────────────────────────────────────
  // BOT_REPLY Handler
  // ────────────────────────────────────────────────────────────────────

  private async handleBotReply(
    cmd: ConversationCommand & { payload: BotReplyPayload },
    sequence: number,
  ): Promise<void> {
    const {
      messages,
      handoff,
      handoffMeta,
      sessionId,
      status,
      inboundMessageId,
      afterTimestamp,
    } = cmd.payload;

    // Resolve the afterTimestamp from the triggering inbound message
    let resolvedAfterTimestamp = afterTimestamp;
    if (!resolvedAfterTimestamp && inboundMessageId) {
      const [inboundMsg] = await this.messageRepo.findByIds([
        inboundMessageId,
      ]);
      if (inboundMsg?.providerTimestamp) {
        resolvedAfterTimestamp = new Date(
          inboundMsg.providerTimestamp,
        ).getTime();
      }
    }

    // Update bot state
    if (status === 'active') {
      await this.conversationRepo.updateBotState(cmd.conversationId, {
        status: 'active',
        sessionId: sessionId ?? undefined,
      });
    } else if (status === 'ended') {
      await this.conversationRepo.updateBotState(cmd.conversationId, {
        status: 'ended',
        sessionId: null,
        lockedAt: null,
      });
    }

    // Send each bot message via outbound service
    let lastBotMessageId: string | null = null;
    for (const [index, msg] of (messages ?? []).entries()) {
      try {
        const idempotencyKey = `bot:${inboundMessageId}:${index}`;

        if (msg.type === 'text' && msg.text) {
          const result = await this.outboundService.sendBotMessage({
            tenantId: cmd.tenantId,
            conversationId: cmd.conversationId,
            content: msg.text,
            idempotencyKey,
            afterTimestamp: resolvedAfterTimestamp,
            buttons: msg.buttons,
            skipAggregateUpdate: true, // processor handles atomicUpdate
          });
          lastBotMessageId = result?.messageId ?? lastBotMessageId;
        } else if (
          ['image', 'video', 'audio', 'file'].includes(msg.type) &&
          msg.url
        ) {
          const result = await this.outboundService.sendBotMedia({
            tenantId: cmd.tenantId,
            conversationId: cmd.conversationId,
            mediaUrl: msg.url,
            mediaType: msg.type,
            mimeType: msg.mimeType,
            caption: msg.text,
            idempotencyKey,
            afterTimestamp: resolvedAfterTimestamp,
          });
          lastBotMessageId = result?.messageId ?? lastBotMessageId;
        }
      } catch (err: any) {
        this.logger.error(
          `[CONV-OPS] Bot message send failed (msg ${index}): ${err?.message}`,
        );
      }
    }

    // Update aggregate with bot's last message
    if (lastBotMessageId) {
      const lastMsg = messages[messages.length - 1];
      const botPreview = (
        lastMsg?.text || `[${lastMsg?.type ?? 'bot'}]`
      ).substring(0, 200);

      await this.conversationRepo.atomicUpdate(cmd.conversationId, {
        $set: {
          lastMessageId: lastBotMessageId,
          lastMessagePreview: botPreview,
          lastMessageType: lastMsg?.type ?? 'text',
          lastMessageAt: new Date(),
          lastMessageSenderType: 'bot',
          lastMessage: botPreview, // backward compat
          unreadCount: 0, // Bot "reads" the conversation
        },
      });
    }

    this.logger.log(
      `[CONV-OPS] Bot reply processed: seq=${sequence} conv=${cmd.conversationId} ` +
        `msgs=${messages?.length ?? 0} handoff=${handoff}`,
    );

    // Handle handoff if needed (channel-agnostic: works for livechat, WhatsApp, Facebook, Zalo, etc.)
    if (handoff) {
      await this.conversationRepo.markBotHandoff(cmd.conversationId);

      // Read conversation ONCE for handoff context (needed for event payload)
      const conversation = await this.conversationRepo.findById(
        cmd.conversationId,
      );

      // Targeted handoff: assign to specific agent or group
      if (handoffMeta?.target === 'agent' && handoffMeta.agentId) {
        await this.conversationRepo.assignAgent(
          cmd.conversationId,
          handoffMeta.agentId,
        );
        // Outbox event so CRM agent UI receives realtime assignment notification
        await this.saveAndPublishOutboxEvent(
          cmd.conversationId,
          cmd.tenantId,
          OmniEvents.CONVERSATION_ASSIGNED,
          {
            tenantId: cmd.tenantId,
            conversationId: cmd.conversationId,
            agentId: handoffMeta.agentId,
            oldAgentId: null,
            reason: 'bot_handoff_targeted',
          },
        );
      } else if (handoffMeta?.target === 'group' && handoffMeta.groupId) {
        await this.conversationRepo.assignGroup(
          cmd.conversationId,
          handoffMeta.groupId,
        );
        await this.saveAndPublishOutboxEvent(
          cmd.conversationId,
          cmd.tenantId,
          OmniEvents.CONVERSATION_ASSIGNED,
          {
            tenantId: cmd.tenantId,
            conversationId: cmd.conversationId,
            agentId: null,
            oldAgentId: null,
            groupId: handoffMeta.groupId,
            reason: 'bot_handoff_targeted',
          },
        );
      }

      // Emit handoff event — @OnEvent(BOT_HANDOFF) in orchestration
      // triggers deferred auto-assignment. Include channel context so
      // the assignment engine can apply channel-specific routing rules
      // (e.g., WhatsApp-only agent pool, Facebook group routing, etc.)
      // DO NOT also call orchestration.handleBotHandoff() directly —
      // that would cause double auto-assignment execution.
      this.eventEmitter.emit(OmniEvents.BOT_HANDOFF, {
        tenantId: cmd.tenantId,
        conversationId: cmd.conversationId,
        channelType: conversation?.channelType,
        channelAccount:
          (conversation as any)?.channelAccount ??
          conversation?.channelId?.toString(),
        contactId: conversation?.contactId ?? null,
      });
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // ASSIGN_AGENT Handler (Phase 2)
  // ────────────────────────────────────────────────────────────────────

  private async handleAssignAgent(
    cmd: ConversationCommand & { payload: AssignAgentPayload },
  ): Promise<void> {
    const {
      agentId,
      groupId,
      previousAgentId,
      previousGroupId,
      performedByUserId,
      reason,
      onlyIfUnassigned,
      syncCapacity,
      auditLog,
    } = cmd.payload;

    // CAS: only assign if currently unassigned (for reply-auto-assign)
    if (onlyIfUnassigned && agentId) {
      const committed = await this.conversationRepo.assignIfUnassigned(
        cmd.conversationId,
        agentId,
      );
      if (!committed) {
        this.logger.debug(
          `[CONV-OPS] ASSIGN_AGENT skipped — conv ${cmd.conversationId} already assigned`,
        );
        return;
      }
    } else {
      // Standard assignment
      if (agentId !== undefined) {
        await this.conversationRepo.updateAssignment(
          cmd.conversationId,
          agentId,
        );
      }
      if (groupId !== undefined) {
        await this.conversationRepo.updateGroupAssignment(
          cmd.conversationId,
          groupId,
        );
      }
    }

    // Outbox event for realtime broadcast
    await this.saveAndPublishOutboxEvent(
      cmd.conversationId,
      cmd.tenantId,
      'omni.conversation.assigned',
      {
        tenantId: cmd.tenantId,
        conversationId: cmd.conversationId,
        agentId: agentId ?? null,
        oldAgentId: previousAgentId ?? null,
        groupId: groupId ?? undefined,
        oldGroupId: previousGroupId ?? undefined,
        performedByUserId: performedByUserId ?? null,
        reason,
      },
    );

    this.logger.log(
      `[CONV-OPS] ASSIGN_AGENT: conv=${cmd.conversationId} agent=${agentId} ` +
        `group=${groupId} reason=${reason}`,
    );

    // Post-commit: capacity sync (fire-and-forget, non-transactional)
    if (syncCapacity?.releaseAgentId) {
      this.agentPresenceService
        .releaseConversation(cmd.tenantId, syncCapacity.releaseAgentId)
        .catch(() => {});
    }
    if (syncCapacity?.assignAgentId) {
      this.agentPresenceService
        .assignConversation(cmd.tenantId, syncCapacity.assignAgentId)
        .catch(() => {});
    }

    // Post-commit: audit log for routing history
    if (auditLog?.channelType && agentId !== undefined) {
      if (reason === 'reply_auto_assign') {
        this.assignmentService
          .logReplyAutoAssignment({
            conversationId: cmd.conversationId,
            tenantId: cmd.tenantId,
            agentId: agentId!,
            channelType: auditLog.channelType,
          })
          .catch(() => {});
      } else {
        this.assignmentService
          .logManualAssignment({
            conversationId: cmd.conversationId,
            tenantId: cmd.tenantId,
            newAgentId: agentId ?? null,
            previousAgentId: previousAgentId ?? null,
            performedByUserId: performedByUserId ?? null,
            channelType: auditLog.channelType,
          })
          .catch(() => {});
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // CHANGE_STATUS Handler (Phase 2)
  // ────────────────────────────────────────────────────────────────────

  private async handleChangeStatus(
    cmd: ConversationCommand & { payload: ChangeStatusPayload },
  ): Promise<void> {
    const {
      newStatus,
      oldStatus,
      agentId,
      reason,
      note,
      resolveSource,
      channelType,
      channelAccount,
      externalConversationId,
    } = cmd.payload;

    if (newStatus === 'resolved' || newStatus === 'closed') {
      await this.conversationRepo.updateStatusWithMetadata(
        cmd.conversationId,
        newStatus,
        agentId ?? null,
        reason,
        note,
        resolveSource ?? 'agent',
      );
    } else {
      await this.conversationRepo.updateStatus(
        cmd.conversationId,
        newStatus,
      );
    }

    // Outbox event for cache invalidation + realtime broadcast
    await this.saveAndPublishOutboxEvent(
      cmd.conversationId,
      cmd.tenantId,
      'omni.conversation.status_changed',
      {
        tenantId: cmd.tenantId,
        conversationId: cmd.conversationId,
        status: newStatus,
        oldStatus,
        agentId,
        reason,
        note,
        resolveSource: resolveSource ?? 'agent',
        channelType,
        channelAccount,
        externalConversationId,
      },
    );

    this.logger.log(
      `[CONV-OPS] CHANGE_STATUS: conv=${cmd.conversationId} ` +
        `${oldStatus} → ${newStatus} (source=${resolveSource})`,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // UPDATE_BOT_STATE Handler (Phase 2)
  // ────────────────────────────────────────────────────────────────────

  private async handleUpdateBotState(
    cmd: ConversationCommand & { payload: UpdateBotStatePayload },
  ): Promise<void> {
    const { botState, reason, agentId } = cmd.payload;

    await this.conversationRepo.updateBotState(
      cmd.conversationId,
      botState as Parameters<typeof this.conversationRepo.updateBotState>[1],
    );

    // Determine event type based on the mutation
    let eventType: string;
    if (botState.enabled === false) {
      eventType = 'omni.bot.disabled';
    } else if (botState.enabled === true) {
      eventType = 'omni.bot.enabled';
    } else if (botState.lastError) {
      eventType = 'omni.bot.error';
    } else {
      eventType = 'omni.bot.state_updated';
    }

    await this.saveAndPublishOutboxEvent(
      cmd.conversationId,
      cmd.tenantId,
      eventType,
      {
        tenantId: cmd.tenantId,
        conversationId: cmd.conversationId,
        reason,
        agentId,
        botState,
      },
    );

    this.logger.log(
      `[CONV-OPS] UPDATE_BOT_STATE: conv=${cmd.conversationId} ` +
        `reason=${reason} enabled=${botState.enabled} status=${botState.status}`,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Idempotency
  // ────────────────────────────────────────────────────────────────────

  private async checkIdempotency(cmd: ConversationCommand): Promise<boolean> {
    try {
      await this.processedOpsModel.create({
        operationId: cmd.operationId,
        conversationId: cmd.conversationId,
        tenantId: cmd.tenantId,
      });
      return false; // New — not yet processed
    } catch (err: any) {
      if (err?.code === 11000) {
        this.logger.debug(
          `[CONV-OPS] Idempotency hit — skipping op=${cmd.operationId}`,
        );
        return true; // Already processed
      }
      throw err; // Unexpected error
    }
  }

  private async markProcessed(cmd: ConversationCommand): Promise<void> {
    // Already inserted in checkIdempotency — nothing to do.
    // The record exists and will auto-purge via TTL index after 30 days.
  }

  // ────────────────────────────────────────────────────────────────────
  // Outbox
  // ────────────────────────────────────────────────────────────────────

  private async saveAndPublishOutboxEvent(
    conversationId: string,
    tenantId: string,
    eventType: string,
    payload: Record<string, any>,
  ): Promise<void> {
    // Save to outbox (will be picked up by poller if in-process publish fails)
    const outboxDoc = await this.outboxModel.create({
      conversationId,
      tenantId,
      eventType,
      payload,
      status: 'pending',
    });

    // Best-effort in-process publish
    try {
      this.eventEmitter.emit(eventType, payload);
      // Use _id for update to avoid matching wrong record when multiple
      // pending events exist for the same conversation + eventType.
      await this.outboxModel.updateOne(
        { _id: outboxDoc._id },
        { $set: { status: 'published', publishedAt: new Date() } },
      );
    } catch (err: any) {
      this.logger.warn(
        `[CONV-OPS] In-process event publish failed (outbox poller will retry): ${err?.message}`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Structured Logging
  // ────────────────────────────────────────────────────────────────────

  private logOperationWarning(
    cmd: ConversationCommand,
    operation: string,
    err: any,
  ): void {
    this.logger.warn(
      `[CONV-OPS] Non-critical op failed: ${operation} ` +
        `op=${cmd.operationId} conv=${cmd.conversationId} ` +
        `tenant=${cmd.tenantId} error=${err?.message}`,
    );
  }
}
