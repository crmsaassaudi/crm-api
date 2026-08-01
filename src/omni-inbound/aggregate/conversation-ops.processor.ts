import { Processor, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Job, Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { logSwallowed } from '../../common/utils/log-swallowed';

import { BaseTenantConsumer } from '../../queue/base-tenant.consumer';
import { RedisLockService } from '../../redis/redis-lock.service';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { InboundOrchestrationService } from '../services/inbound-orchestration.service';
import { MediaProxyService } from '../services/media-proxy.service';
import { OmniEvents } from '../domain/omni-events';
import {
  assertConversationStatusTransition,
  isConversationStatus,
} from '../domain/conversation-status';

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
  PREVIEW_MAX_LENGTH,
  PRESIGNED_URL_TTL_SEC,
  SLOW_OP_THRESHOLD_MS,
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
import { canAcceptBotCallback } from '../bot/bot-state-machine';
import { WorkDistributionService } from '../work-distribution/work-distribution.service';

import { ModuleRef } from '@nestjs/core';
import { OMNI_CONCURRENCY } from '../../queue/config/worker-concurrency';
import { isOmniRuntime, isWorkerRuntime } from '../../config/runtime-role';

/** Only the commands that append a message need a per-conversation ordinal. */
function needsSequence(type: ConversationCommand['type']): boolean {
  return type === 'CUSTOMER_MESSAGE' || type === 'BOT_REPLY';
}

/**
 * Aggregate Root processor — serializes all conversation mutations
 * via per-conversation Redis locks and BullMQ queue.
 *
 * The class is always provided, because controllers reach it directly for
 * inline execution, but on an API-only pod the BullMQ worker stays parked:
 * `@Processor` starts a worker as a side effect of being instantiated, so an
 * API replica would otherwise consume aggregate commands alongside serving
 * HTTP, putting queue work on the latency-critical pod.
 */
@Processor(CONV_OPS_QUEUE, {
  concurrency: OMNI_CONCURRENCY.conversationOps(),
  autorun: isWorkerRuntime() || isOmniRuntime(),
})
export class ConversationOpsProcessor
  extends BaseTenantConsumer<ConversationCommand>
  implements OnModuleInit
{
  protected readonly logger = new Logger(ConversationOpsProcessor.name);
  protected readonly cls: ClsService;
  private orchestration!: InboundOrchestrationService;

  constructor(
    cls: ClsService,
    private readonly lockService: RedisLockService,
    private readonly conversationRepo: ConversationRepository,
    private readonly messageRepo: MessageRepository,
    private readonly mediaProxy: MediaProxyService,
    private readonly eventEmitter: EventEmitter2,
    @InjectModel(ProcessedOperationSchemaClass.name)
    private readonly processedOpsModel: Model<ProcessedOperationDocument>,
    @InjectModel(OutboxEventSchemaClass.name)
    private readonly outboxModel: Model<OutboxEventDocument>,
    @InjectQueue(CONV_OPS_DLQ) private readonly dlqQueue: Queue,
    private readonly outboundService: OutboundService,
    private readonly agentPresenceService: AgentPresenceService,
    private readonly assignmentService: AssignmentService,
    private readonly workDistribution: WorkDistributionService,
    private readonly moduleRef: ModuleRef,
  ) {
    super();
    this.cls = cls;
  }

  onModuleInit() {
    this.orchestration = this.moduleRef.get(InboundOrchestrationService, {
      strict: false,
    });
  }

  protected async handle(job: Job<ConversationCommand>): Promise<void> {
    const cmd = job.data;
    const lockKey = `${CONV_OPS_LOCK_PREFIX}${cmd.conversationId}`;

    try {
      await this.lockService.acquire(
        lockKey,
        CONV_OPS_LOCK_TTL_MS,
        async () => {
          await this.processCommand(cmd);
        },
      );
    } catch (error) {
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
        this.eventEmitter.emit('conv-ops.dlq.entered', dlqPayload);
        return;
      }
      throw error;
    }
  }

  // ── Inline Execution ──────────────────────────────────────────────

  /** Execute synchronously within the aggregate lock. Returns updated conversation. */
  async executeInline(cmd: ConversationCommand): Promise<any> {
    const lockKey = `${CONV_OPS_LOCK_PREFIX}${cmd.conversationId}`;

    return this.lockService.acquire(lockKey, CONV_OPS_LOCK_TTL_MS, async () => {
      await this.processCommand(cmd);
      return this.conversationRepo.findById(cmd.conversationId);
    });
  }

  // ── Command Router ────────────────────────────────────────────────

  private async processCommand(cmd: ConversationCommand): Promise<void> {
    const startTime = Date.now();
    this.cls.set('correlationId', cmd.operationId);
    this.cls.set('conversationId', cmd.conversationId);

    const claim = await this.claimOperation(cmd);
    if (!claim) return;
    const { sequence } = claim;

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

    await this.completeOperation(cmd.operationId);

    const duration = Date.now() - startTime;
    this.logger.debug(
      `[CONV-OPS] ✓ ${cmd.type} op=${cmd.operationId} ` +
        `conv=${cmd.conversationId} duration=${duration}ms`,
    );
    if (duration > SLOW_OP_THRESHOLD_MS) {
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
    const { omniPayload: payload, messageDedupId } = cmd.payload;
    const msgTimestamp = payload.providerTimestamp ?? payload.timestamp;

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
        providerTimestamp: msgTimestamp,
        sequence,
      });

    if (!inserted) {
      this.logger.debug(
        `[CONV-OPS] Duplicate inbound message ${messageDedupId} — skipping`,
      );
      return;
    }

    if (!payload.mediaUrl && payload.metadata?.media?.storageKey) {
      try {
        const presignedUrl = await this.mediaProxy.getPresignedUrl(
          payload.metadata.media.storageKey,
          PRESIGNED_URL_TTL_SEC,
        );
        payload.mediaProxyUrl = presignedUrl;
      } catch (err: any) {
        this.logger.warn(
          `Failed to resolve presigned URL for visitor upload ${message.id}: ${err?.message}`,
        );
      }
    }

    const preview = (payload.content || `[${payload.messageType}]`).substring(
      0,
      PREVIEW_MAX_LENGTH,
    );

    // The preview fields describe the *latest* message, so a message that turns
    // out to be older than the one already summarised must not overwrite them —
    // otherwise a retried or late-delivered message rewinds the inbox row.
    // The counters are unconditional: they count arrivals, not recency.
    await this.conversationRepo.applyIncomingMessage(cmd.conversationId, {
      sequence,
      counters: {
        messageCount: 1,
        unreadCount: payload.senderType === 'customer' ? 1 : 0,
      },
      preview: {
        lastMessageId: message.id,
        lastMessagePreview: preview,
        lastMessageType: payload.messageType,
        lastMessageAt: msgTimestamp,
        lastMessageSenderType: payload.senderType,
        lastMessage: preview,
        ...(payload.senderType === 'customer'
          ? { lastCustomerMessageAt: msgTimestamp }
          : {}),
      },
    });

    this.logger.debug(
      `[CONV-OPS] Saved message ${messageDedupId} seq=${sequence} conv=${cmd.conversationId}`,
    );

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

    await this.orchestration
      .rescheduleAutoResolve(payload.tenantId, cmd.conversationId)
      .catch((err) =>
        this.logOperationWarning(cmd, 'rescheduleAutoResolve', err),
      );

    const conversationSnapshot = await this.conversationRepo.findById(
      cmd.conversationId,
    );

    await this.orchestration.enqueueBotProcessingIfNeeded(
      payload,
      cmd.conversationId,
      message.id,
      payload.providerTimestamp ?? payload.timestamp,
      conversationSnapshot,
    );

    // A pending work offer counts as "a human has this": auto-routing commits
    // an offer rather than an assignment, so `assignedAgentId` alone is null
    // for a conversation that was just handed to an online agent.
    const handledByHuman =
      !!conversationSnapshot?.assignedAgentId ||
      (await this.hasPendingOffer(cmd.conversationId));

    await this.orchestration
      .handleBusinessHoursCheck(payload, cmd.conversationId, handledByHuman)
      .catch((err) => this.logOperationWarning(cmd, 'businessHoursCheck', err));
  }

  private async hasPendingOffer(conversationId: string): Promise<boolean> {
    try {
      return await this.workDistribution.hasOpenOffer(conversationId);
    } catch {
      // Unknown means "do not suppress" — a missing out-of-hours reply is a
      // worse outcome than a redundant one.
      return false;
    }
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
      endReason,
      inboundMessageId,
      afterTimestamp,
    } = cmd.payload;

    // This check runs inside the per-conversation aggregate lock. A callback
    // queued before an agent takeover but processed after it therefore cannot
    // reactivate the bot or send a late bot response.
    const currentConversation = await this.conversationRepo.findById(
      cmd.conversationId,
    );
    if (
      !currentConversation ||
      !canAcceptBotCallback(currentConversation.bot, sessionId)
    ) {
      this.logger.warn(
        `[CONV-OPS] Ignored stale bot callback: conv=${cmd.conversationId} session=${sessionId ?? 'none'}`,
      );
      return;
    }

    // Resolve the afterTimestamp from the triggering inbound message
    let resolvedAfterTimestamp = afterTimestamp;
    if (!resolvedAfterTimestamp && inboundMessageId) {
      const [inboundMsg] = await this.messageRepo.findByIds([inboundMessageId]);
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
      });
    }

    // Send each bot message via outbound service
    const lastBotMessageId = await this.sendBotMessages(
      cmd,
      messages,
      inboundMessageId,
      resolvedAfterTimestamp,
    );

    // Update aggregate with bot's last message
    if (lastBotMessageId) {
      await this.updateConversationWithLastBotMessage(
        cmd.conversationId,
        messages,
        lastBotMessageId,
      );
    }

    this.logger.log(
      `[CONV-OPS] Bot reply processed: seq=${sequence} conv=${cmd.conversationId} ` +
        `msgs=${messages?.length ?? 0} handoff=${handoff}`,
    );

    if (handoff) {
      await this.handleBotHandoff(cmd, handoffMeta);
    } else if (status === 'ended') {
      await this.handleBotEnded(cmd, endReason, sessionId);
    }
  }

  /**
   * A bot session that ends without a handoff still has to release the
   * conversation: in `bot_first` mode auto-assignment was deferred when the
   * conversation was created, so without this the conversation is left with no
   * bot and no agent and the customer's next message goes nowhere.
   */
  private async handleBotEnded(
    cmd: ConversationCommand & { payload: BotReplyPayload },
    endReason: BotReplyPayload['endReason'],
    sessionId: string | undefined,
  ): Promise<void> {
    const conversation = await this.conversationRepo.findById(
      cmd.conversationId,
    );
    if (!conversation) return;

    await this.saveAndPublishOutboxEvent(
      cmd.conversationId,
      cmd.tenantId,
      OmniEvents.BOT_ENDED,
      {
        tenantId: cmd.tenantId,
        conversationId: cmd.conversationId,
        channelType: conversation.channelType,
        channelAccount:
          conversation.channelAccount ?? conversation.channelId?.toString(),
        contactId: conversation.contactId ?? null,
        inboundMessageId: cmd.payload.inboundMessageId,
        sessionId,
        reason: endReason ?? 'flow_completed',
      },
    );
  }

  private async sendBotMessages(
    cmd: ConversationCommand,
    messages: any[],
    inboundMessageId: string | undefined,
    resolvedAfterTimestamp: number | undefined,
  ): Promise<string | null> {
    let lastBotMessageId: string | null = null;
    for (const [index, msg] of (messages ?? []).entries()) {
      try {
        const idempotencyKey = `bot:${inboundMessageId}:${index}`;
        let result: { messageId: string } | null = null;

        if (msg.type === 'text' && msg.text) {
          result = await this.outboundService.sendBotMessage({
            tenantId: cmd.tenantId,
            conversationId: cmd.conversationId,
            content: msg.text,
            idempotencyKey,
            afterTimestamp: resolvedAfterTimestamp,
            buttons: msg.buttons,
            skipAggregateUpdate: true,
          });
        } else if (
          ['image', 'video', 'audio', 'file'].includes(msg.type) &&
          msg.url
        ) {
          result = await this.outboundService.sendBotMedia({
            tenantId: cmd.tenantId,
            conversationId: cmd.conversationId,
            mediaUrl: msg.url,
            mediaType: msg.type,
            mimeType: msg.mimeType,
            caption: msg.text,
            idempotencyKey: idempotencyKey ?? undefined,
            afterTimestamp: resolvedAfterTimestamp,
          });
        }
        lastBotMessageId = result?.messageId ?? lastBotMessageId;
      } catch (err: any) {
        this.logger.error(
          `[CONV-OPS] Bot message send failed (msg ${index}): ${err?.message}`,
        );
      }
    }
    return lastBotMessageId;
  }

  private async updateConversationWithLastBotMessage(
    conversationId: string,
    messages: any[],
    lastBotMessageId: string,
  ): Promise<void> {
    const lastMsg = messages[messages.length - 1];
    const botPreview = (
      lastMsg?.text || `[${lastMsg?.type ?? 'bot'}]`
    ).substring(0, PREVIEW_MAX_LENGTH);

    await this.conversationRepo.atomicUpdate(conversationId, {
      $set: {
        lastMessageId: lastBotMessageId,
        lastMessagePreview: botPreview,
        lastMessageType: lastMsg?.type ?? 'text',
        lastMessageAt: new Date(),
        lastMessageSenderType: 'bot',
        lastMessage: botPreview,
        unreadCount: 0,
      },
    });
  }

  private async handleBotHandoff(
    cmd: ConversationCommand,
    handoffMeta: any,
  ): Promise<void> {
    const target = handoffMeta?.target ?? 'general';
    const targetId =
      target === 'agent'
        ? handoffMeta?.agentId
        : target === 'group'
          ? handoffMeta?.groupId
          : undefined;
    const conversation = await this.conversationRepo.markBotHandoff(
      cmd.conversationId,
      {
        reason: 'bot_requested_handoff',
        message: handoffMeta?.message,
        target,
        targetId,
        inboundMessageId: cmd.payload.inboundMessageId,
      },
    );
    // Duplicate/stale callbacks cannot repeat routing or handoff events.
    if (!conversation) return;
    const previousAgentId = conversation?.assignedAgentId
      ? String(conversation.assignedAgentId)
      : null;
    const channelType = conversation?.channelType ?? 'unknown';

    // Routed through the same primitives `handleAssignAgent` uses — this used
    // to write `assignedAgentId`/`assignedGroupId` directly, so a targeted
    // bot handoff never reached `assignment_audit_logs` and never moved the
    // agent's Redis capacity counter, leaving them silently over capacity.
    if (handoffMeta?.target === 'agent' && handoffMeta.agentId) {
      const committed = await this.performAssignmentUpdate(
        cmd.conversationId,
        handoffMeta.agentId,
        undefined,
        false,
        previousAgentId,
      );
      if (committed) {
        this.syncPresenceOnAssignment(cmd.tenantId, {
          assignAgentId: handoffMeta.agentId,
          releaseAgentId:
            previousAgentId && previousAgentId !== handoffMeta.agentId
              ? previousAgentId
              : undefined,
        });
        this.logAssignmentAuditTrail(
          cmd.tenantId,
          cmd.conversationId,
          handoffMeta.agentId,
          previousAgentId,
          null,
          channelType,
          'bot_handoff_targeted',
        );
        await this.publishAssignmentEvent(
          cmd,
          handoffMeta.agentId,
          null,
          'bot_handoff_targeted',
        );
      }
    } else if (handoffMeta?.target === 'group' && handoffMeta.groupId) {
      const committed = await this.performAssignmentUpdate(
        cmd.conversationId,
        undefined,
        handoffMeta.groupId,
        false,
      );
      if (committed) {
        this.logAssignmentAuditTrail(
          cmd.tenantId,
          cmd.conversationId,
          undefined,
          previousAgentId,
          null,
          channelType,
          'bot_handoff_targeted',
          handoffMeta.groupId,
        );
        await this.publishAssignmentEvent(
          cmd,
          null,
          handoffMeta.groupId,
          'bot_handoff_targeted',
        );
      }
    }

    await this.saveAndPublishOutboxEvent(
      cmd.conversationId,
      cmd.tenantId,
      OmniEvents.BOT_HANDOFF,
      {
        tenantId: cmd.tenantId,
        conversationId: cmd.conversationId,
        channelType: conversation.channelType,
        channelAccount:
          conversation.channelAccount ?? conversation.channelId?.toString(),
        contactId: conversation.contactId ?? null,
        inboundMessageId: cmd.payload.inboundMessageId,
        sessionId: cmd.payload.sessionId,
        handoff: {
          target,
          targetId: targetId ?? null,
          message: handoffMeta?.message ?? null,
        },
      },
    );
  }

  private async publishAssignmentEvent(
    cmd: ConversationCommand,
    agentId: string | null,
    groupId: string | null,
    reason: string,
  ): Promise<void> {
    await this.saveAndPublishOutboxEvent(
      cmd.conversationId,
      cmd.tenantId,
      OmniEvents.CONVERSATION_ASSIGNED,
      {
        tenantId: cmd.tenantId,
        conversationId: cmd.conversationId,
        agentId,
        oldAgentId: null,
        groupId: groupId ?? undefined,
        reason,
      },
    );
  }

  // ── ASSIGN_AGENT Handler ─────────────────────────────────────────

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

    const committed = await this.performAssignmentUpdate(
      cmd.conversationId,
      agentId,
      groupId,
      onlyIfUnassigned,
      previousAgentId,
    );
    if (!committed) return;

    await this.emitAssignmentEvents(
      cmd,
      agentId,
      previousAgentId,
      groupId,
      previousGroupId,
      performedByUserId,
      reason,
    );

    this.logger.log(
      `[CONV-OPS] ASSIGN_AGENT: conv=${cmd.conversationId} agent=${agentId} group=${groupId} reason=${reason}`,
    );

    this.syncPresenceOnAssignment(cmd.tenantId, syncCapacity);

    if (
      auditLog?.channelType &&
      (agentId !== undefined || groupId !== undefined)
    ) {
      this.logAssignmentAuditTrail(
        cmd.tenantId,
        cmd.conversationId,
        agentId,
        previousAgentId,
        performedByUserId,
        auditLog.channelType,
        reason,
        groupId,
      );
    }
  }

  private async performAssignmentUpdate(
    conversationId: string,
    agentId: string | null | undefined,
    groupId: string | null | undefined,
    onlyIfUnassigned: boolean | undefined,
    previousAgentId?: string | null,
  ): Promise<boolean> {
    if (onlyIfUnassigned && agentId) {
      const committed = await this.conversationRepo.assignIfUnassigned(
        conversationId,
        agentId,
      );
      if (!committed) {
        this.logger.debug(
          `[CONV-OPS] ASSIGN_AGENT skipped — conv ${conversationId} already assigned`,
        );
        return false;
      }
    } else if (agentId !== undefined && previousAgentId !== undefined) {
      // The caller attested to the agent it observed before deciding to
      // change it — CAS against that instead of writing unconditionally, so
      // a stale decision (the assignee changed since the caller last read it)
      // is rejected rather than silently clobbering a newer assignment.
      const committed = await this.conversationRepo.reassignIfExpected(
        conversationId,
        agentId,
        groupId,
        previousAgentId,
      );
      if (!committed) {
        this.logger.debug(
          `[CONV-OPS] ASSIGN_AGENT conflict — conv ${conversationId} assignee changed since read, expected ${previousAgentId}`,
        );
        return false;
      }
    } else {
      if (agentId !== undefined)
        await this.conversationRepo.updateAssignment(
          conversationId,
          agentId ?? null,
        );
      if (groupId !== undefined)
        await this.conversationRepo.updateGroupAssignment(
          conversationId,
          groupId ?? null,
        );
    }
    return true;
  }

  private async emitAssignmentEvents(
    cmd: ConversationCommand,
    agentId: string | null | undefined,
    previousAgentId: string | null | undefined,
    groupId: string | null | undefined,
    previousGroupId: string | null | undefined,
    performedByUserId: string | null | undefined,
    reason: string,
  ): Promise<void> {
    await this.saveAndPublishOutboxEvent(
      cmd.conversationId,
      cmd.tenantId,
      OmniEvents.CONVERSATION_ASSIGNED,
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
  }

  private syncPresenceOnAssignment(tenantId: string, syncCapacity: any): void {
    if (syncCapacity?.releaseAgentId) {
      this.agentPresenceService
        .releaseConversation(
          tenantId,
          syncCapacity.releaseAgentId,
          syncCapacity.releaseWeight,
        )
        .catch(logSwallowed(this.logger, 'releaseConversation'));
    }
    if (syncCapacity?.assignAgentId) {
      this.agentPresenceService
        .assignConversation(
          tenantId,
          syncCapacity.assignAgentId,
          syncCapacity.assignWeight,
        )
        .catch(logSwallowed(this.logger, 'assignConversation'));
    }
  }

  private logAssignmentAuditTrail(
    tenantId: string,
    conversationId: string,
    agentId: string | null | undefined,
    previousAgentId: string | null | undefined,
    performedByUserId: string | null | undefined,
    channelType: string,
    reason: string,
    groupId?: string | null,
  ): void {
    if (reason === 'reply_auto_assign') {
      this.assignmentService
        .logReplyAutoAssignment({
          conversationId,
          tenantId,
          agentId: agentId!,
          channelType,
        })
        .catch(logSwallowed(this.logger, 'logReplyAutoAssignment'));
    } else {
      this.assignmentService
        .logManualAssignment({
          conversationId,
          tenantId,
          // Preserve `undefined` (agent field untouched — a group-only
          // change) rather than collapsing it to null (explicit unassign).
          newAgentId: agentId,
          previousAgentId: previousAgentId ?? null,
          performedByUserId: performedByUserId ?? null,
          channelType,
          groupId,
        })
        .catch(logSwallowed(this.logger, 'logManualAssignment'));
    }
  }

  // ── CHANGE_STATUS Handler ────────────────────────────────────────

  private async handleChangeStatus(
    cmd: ConversationCommand & { payload: ChangeStatusPayload },
  ): Promise<void> {
    const {
      newStatus,
      agentId,
      reason,
      note,
      resolveSource,
      channelType,
      channelAccount,
      externalConversationId,
    } = cmd.payload;

    const current = await this.conversationRepo.findById(cmd.conversationId);
    if (!current) {
      throw new Error(`Conversation ${cmd.conversationId} not found`);
    }
    if (!isConversationStatus(current.status)) {
      throw new Error(
        `Conversation ${cmd.conversationId} has unknown status ${current.status}`,
      );
    }
    assertConversationStatusTransition(current.status, newStatus);
    const effectiveOldStatus = current.status;

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
      await this.conversationRepo.updateStatus(cmd.conversationId, newStatus);
    }

    await this.saveAndPublishOutboxEvent(
      cmd.conversationId,
      cmd.tenantId,
      OmniEvents.CONVERSATION_STATUS_CHANGED,
      {
        tenantId: cmd.tenantId,
        conversationId: cmd.conversationId,
        status: newStatus,
        oldStatus: effectiveOldStatus,
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
        `${effectiveOldStatus} → ${newStatus} (source=${resolveSource})`,
    );
  }

  // ── UPDATE_BOT_STATE Handler ─────────────────────────────────────

  private async handleUpdateBotState(
    cmd: ConversationCommand & { payload: UpdateBotStatePayload },
  ): Promise<void> {
    const { botState, reason, agentId } = cmd.payload;

    await this.conversationRepo.updateBotState(
      cmd.conversationId,
      botState as Parameters<typeof this.conversationRepo.updateBotState>[1],
    );

    let eventType: string;
    if (botState.enabled === false) eventType = OmniEvents.BOT_DISABLED;
    else if (botState.enabled === true) eventType = OmniEvents.BOT_ENABLED;
    else if (botState.lastError) eventType = 'omni.bot.error';
    else eventType = 'omni.bot.state_updated';

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

  /**
   * Take (or resume) ownership of a command.
   *
   * Returns the allocated sequence, or null when the command has already run to
   * completion. An incomplete record means a previous attempt of *this* job
   * died partway, so the retry resumes it — reusing the sequence it already
   * allocated rather than taking a fresh one behind newer messages.
   */
  private async claimOperation(
    cmd: ConversationCommand,
  ): Promise<{ sequence: number } | null> {
    const existing = await this.processedOpsModel
      .findOne({ operationId: cmd.operationId })
      .lean()
      .exec();

    if (existing?.completedAt) {
      this.logger.debug(
        `[CONV-OPS] Already completed — skipping op=${cmd.operationId}`,
      );
      return null;
    }

    if (existing) {
      this.logger.warn(
        `[CONV-OPS] Resuming interrupted op=${cmd.operationId} type=${cmd.type} ` +
          `conv=${cmd.conversationId}`,
      );
      return { sequence: existing.sequence ?? 0 };
    }

    const sequence = needsSequence(cmd.type)
      ? await this.conversationRepo.getNextSequence(cmd.conversationId)
      : 0;

    try {
      await this.processedOpsModel.create({
        operationId: cmd.operationId,
        conversationId: cmd.conversationId,
        tenantId: cmd.tenantId,
        sequence,
      });
    } catch (err: any) {
      // Lost a race with a concurrent attempt of the same job; that attempt owns
      // the command and its sequence.
      if (err?.code !== 11000) throw err;
      const winner = await this.processedOpsModel
        .findOne({ operationId: cmd.operationId })
        .lean()
        .exec();
      if (winner?.completedAt) return null;
      return { sequence: winner?.sequence ?? sequence };
    }

    return { sequence };
  }

  private async completeOperation(operationId: string): Promise<void> {
    await this.processedOpsModel
      .updateOne({ operationId }, { $set: { completedAt: new Date() } })
      .exec();
  }

  // ── Outbox ─────────────────────────────────────────────────────

  /**
   * Record the event, then publish it — and only mark it published once every
   * listener has actually finished.
   *
   * `emit()` is fire-and-forget: it does not await async listeners, so their
   * rejections never reached the `catch` here and the row was flipped to
   * `published` regardless. That made the table a log of attempts rather than
   * an outbox, and left the poller — the only retry path — with nothing to find.
   */
  private async saveAndPublishOutboxEvent(
    conversationId: string,
    tenantId: string,
    eventType: string,
    payload: Record<string, any>,
  ): Promise<void> {
    const outboxDoc = await this.outboxModel.create({
      conversationId,
      tenantId,
      eventType,
      payload,
      status: 'pending',
    });

    try {
      await this.eventEmitter.emitAsync(eventType, payload);
      await this.outboxModel.updateOne(
        { _id: outboxDoc._id },
        { $set: { status: 'published', publishedAt: new Date() } },
      );
    } catch (err: any) {
      // Left pending on purpose: OutboxPublisherService retries it with the
      // tenant context restored.
      this.logger.warn(
        `[CONV-OPS] Publish of ${eventType} failed, outbox poller will retry: ${err?.message}`,
      );
    }
  }

  // ── Helpers ────────────────────────────────────────────────────

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
