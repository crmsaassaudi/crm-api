import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { OnEvent } from '@nestjs/event-emitter';
import { ulid } from 'ulid';

import { OmniPayload } from '../domain/omni-payload';
import {
  ConversationCommand,
  BotGeneratedReplyEvent,
  CustomerMessagePayload,
  AssignAgentPayload,
  ChangeStatusPayload,
  UpdateBotStatePayload,
} from './conversation-command.types';
import {
  CONV_OPS_QUEUE,
  CONV_OPS_MAX_ATTEMPTS,
  BOT_GENERATED_REPLY_EVENT,
} from './conversation-ops.constants';
import { ConversationOpsProcessor } from './conversation-ops.processor';

/**
 * ConversationCommandService — builds and enqueues typed commands
 * into the conversation-ops BullMQ queue.
 *
 * This is the ONLY entry point for creating conversation operations.
 * No service should mutate conversation state directly; instead they
 * call methods on this service which enqueue the appropriate command.
 *
 * The service also listens for decoupled events (e.g. bot.generated_reply)
 * and converts them into commands automatically.
 */
@Injectable()
export class ConversationCommandService {
  private readonly logger = new Logger(ConversationCommandService.name);

  constructor(
    @InjectQueue(CONV_OPS_QUEUE) private readonly opsQueue: Queue,
    @Inject(forwardRef(() => ConversationOpsProcessor))
    private readonly processor: ConversationOpsProcessor,
  ) {}

  /**
   * Enqueue a CUSTOMER_MESSAGE command.
   *
   * Called by ConversationService after identity resolution and
   * conversation find-or-create logic (reads only). The processor
   * will handle message persistence, aggregate update, and event emission.
   */
  async enqueueCustomerMessage(
    conversationId: string,
    tenantId: string,
    omniPayload: OmniPayload,
    messageDedupId: string,
    idemKey: string,
  ): Promise<void> {
    const operationId = ulid();

    const command: ConversationCommand = {
      operationId,
      sourceId: `inbound:${messageDedupId}`,
      type: 'CUSTOMER_MESSAGE',
      conversationId,
      tenantId,
      payload: {
        omniPayload,
        messageDedupId,
        idemKey,
      } satisfies CustomerMessagePayload,
      createdAt: new Date().toISOString(),
    };

    await this.enqueue(command);

    this.logger.debug(
      `[CONV-CMD] Enqueued CUSTOMER_MESSAGE op=${operationId} conv=${conversationId}`,
    );
  }

  /**
   * Listen for bot.generated_reply events and convert to BOT_REPLY command.
   *
   * This decoupling allows any future bot source (AI Agent, Flow Builder,
   * External Automation) to emit the same event without touching the
   * aggregate architecture.
   */
  @OnEvent(BOT_GENERATED_REPLY_EVENT)
  async handleBotGeneratedReply(event: BotGeneratedReplyEvent): Promise<void> {
    const operationId = ulid();

    const command: ConversationCommand = {
      operationId,
      sourceId: `bot:${event.inboundMessageId}`,
      type: 'BOT_REPLY',
      conversationId: event.conversationId,
      tenantId: event.tenantId,
      payload: {
        messages: event.messages,
        handoff: event.handoff,
        handoffMeta: event.handoffMeta,
        sessionId: event.sessionId,
        status: event.status,
        inboundMessageId: event.inboundMessageId,
        afterTimestamp: event.afterTimestamp,
      },
      createdAt: new Date().toISOString(),
    };

    await this.enqueue(command);

    this.logger.debug(
      `[CONV-CMD] Enqueued BOT_REPLY op=${operationId} conv=${event.conversationId} ` +
        `msgs=${event.messages?.length ?? 0} handoff=${event.handoff}`,
    );
  }

  // ── Phase 2 Commands ──────────────────────────────────────────────

  /**
   * Enqueue an ASSIGN_AGENT command.
   * Handles agent assignment, group assignment, unassignment, and takeover.
   */
  async enqueueAssignAgent(
    conversationId: string,
    tenantId: string,
    payload: AssignAgentPayload,
  ): Promise<string> {
    const operationId = ulid();

    await this.enqueue({
      operationId,
      sourceId: `assign:${conversationId}:${operationId}`,
      type: 'ASSIGN_AGENT',
      conversationId,
      tenantId,
      payload,
      createdAt: new Date().toISOString(),
    });

    this.logger.debug(
      `[CONV-CMD] Enqueued ASSIGN_AGENT op=${operationId} conv=${conversationId} ` +
        `agent=${payload.agentId} reason=${payload.reason}`,
    );

    return operationId;
  }

  /**
   * Enqueue a CHANGE_STATUS command.
   * Handles open, pending, resolved, closed transitions.
   */
  async enqueueChangeStatus(
    conversationId: string,
    tenantId: string,
    payload: ChangeStatusPayload,
  ): Promise<string> {
    const operationId = ulid();

    await this.enqueue({
      operationId,
      sourceId: `status:${conversationId}:${operationId}`,
      type: 'CHANGE_STATUS',
      conversationId,
      tenantId,
      payload,
      createdAt: new Date().toISOString(),
    });

    this.logger.debug(
      `[CONV-CMD] Enqueued CHANGE_STATUS op=${operationId} conv=${conversationId} ` +
        `status=${payload.newStatus} source=${payload.resolveSource}`,
    );

    return operationId;
  }

  /**
   * Enqueue an UPDATE_BOT_STATE command.
   * Handles enable/disable bot, error state, auto-init.
   */
  async enqueueUpdateBotState(
    conversationId: string,
    tenantId: string,
    payload: UpdateBotStatePayload,
  ): Promise<string> {
    const operationId = ulid();

    await this.enqueue({
      operationId,
      sourceId: `bot-state:${conversationId}:${operationId}`,
      type: 'UPDATE_BOT_STATE',
      conversationId,
      tenantId,
      payload,
      createdAt: new Date().toISOString(),
    });

    this.logger.debug(
      `[CONV-CMD] Enqueued UPDATE_BOT_STATE op=${operationId} conv=${conversationId} ` +
        `reason=${payload.reason}`,
    );

    return operationId;
  }

  // ── Inline Execution (synchronous controller path) ────────────────
  //
  // Industry standard (Zendesk, HubSpot, Salesforce):
  // Single-record mutations return the updated document synchronously.
  // These methods acquire the aggregate lock and execute inline
  // (bypassing BullMQ queue) for controller use.
  //
  // Background processors should use the enqueue* methods above.
  // ──────────────────────────────────────────────────────────────────

  /**
   * Execute ASSIGN_AGENT synchronously. Returns updated conversation.
   * Use from controllers that need the updated document in the response.
   */
  async executeAssignAgent(
    conversationId: string,
    tenantId: string,
    payload: AssignAgentPayload,
  ): Promise<any> {
    const operationId = ulid();
    const cmd: ConversationCommand = {
      operationId,
      sourceId: `assign:${conversationId}:${operationId}`,
      type: 'ASSIGN_AGENT',
      conversationId,
      tenantId,
      payload,
      createdAt: new Date().toISOString(),
    };
    this.logger.debug(
      `[CONV-CMD] Inline ASSIGN_AGENT op=${operationId} conv=${conversationId} agent=${payload.agentId}`,
    );
    return this.processor.executeInline(cmd);
  }

  /**
   * Execute CHANGE_STATUS synchronously. Returns updated conversation.
   */
  async executeChangeStatus(
    conversationId: string,
    tenantId: string,
    payload: ChangeStatusPayload,
  ): Promise<any> {
    const operationId = ulid();
    const cmd: ConversationCommand = {
      operationId,
      sourceId: `status:${conversationId}:${operationId}`,
      type: 'CHANGE_STATUS',
      conversationId,
      tenantId,
      payload,
      createdAt: new Date().toISOString(),
    };
    this.logger.debug(
      `[CONV-CMD] Inline CHANGE_STATUS op=${operationId} conv=${conversationId} status=${payload.newStatus}`,
    );
    return this.processor.executeInline(cmd);
  }

  /**
   * Execute UPDATE_BOT_STATE synchronously. Returns updated conversation.
   */
  async executeUpdateBotState(
    conversationId: string,
    tenantId: string,
    payload: UpdateBotStatePayload,
  ): Promise<any> {
    const operationId = ulid();
    const cmd: ConversationCommand = {
      operationId,
      sourceId: `bot-state:${conversationId}:${operationId}`,
      type: 'UPDATE_BOT_STATE',
      conversationId,
      tenantId,
      payload,
      createdAt: new Date().toISOString(),
    };
    this.logger.debug(
      `[CONV-CMD] Inline UPDATE_BOT_STATE op=${operationId} conv=${conversationId} reason=${payload.reason}`,
    );
    return this.processor.executeInline(cmd);
  }

  /**
   * Core enqueue — adds a command to the conversation-ops queue.
   * Uses operationId as jobId for BullMQ-level dedup.
   */
  private async enqueue(command: ConversationCommand): Promise<void> {
    await this.opsQueue.add(command.type, command, {
      jobId: command.operationId,
      attempts: CONV_OPS_MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: false, // Keep failed jobs for DLQ inspection
    });
  }
}
