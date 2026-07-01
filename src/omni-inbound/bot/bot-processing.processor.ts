import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { BaseTenantConsumer } from '../../queue/base-tenant.consumer';
import { ConversationRepository } from '../repositories/conversation.repository';
import { BOT_PROCESSING_QUEUE } from '../queue/bot-processing-queue.constants';
import { BotApiService } from './bot-api.service';
import { BotProcessingJobData } from './bot-processing.types';

/**
 * BullMQ processor — fire-and-forget to crm-bot.
 *
 * Flow:
 * 1. Pick job from queue
 * 2. Validate conversation bot state
 * 3. Dispatch to crm-bot (returns 200 immediately)
 * 4. Done — bot will callback to /v1/bot-callback/reply async
 */
@Processor(BOT_PROCESSING_QUEUE)
export class BotProcessingProcessor extends BaseTenantConsumer<BotProcessingJobData> {
  protected readonly logger = new Logger(BotProcessingProcessor.name);
  protected readonly cls: ClsService;

  constructor(
    cls: ClsService,
    private readonly conversationRepo: ConversationRepository,
    private readonly botApi: BotApiService,
  ) {
    super();
    this.cls = cls;
  }

  protected async handle(job: Job<BotProcessingJobData>): Promise<void> {
    const data = job.data;
    this.logger.log(
      `[BOT-PROCESSOR] ▶ Processing job ${job.id} — conv=${data.conversationId}, msg=${data.messageId}, ` +
        `channel=${data.channel}, text="${(data.text || '').substring(0, 50)}"`,
    );

    // 1. Validate conversation state
    const conversation = await this.conversationRepo.findById(
      data.conversationId,
    );
    if (!conversation) {
      this.logger.warn(
        `[BOT-PROCESSOR] ✗ SKIP — Conversation ${data.conversationId} NOT FOUND, job=${job.id}`,
      );
      return;
    }
    if (conversation.tenantId !== data.tenantId) {
      this.logger.error(
        `[BOT-PROCESSOR] ✗ REJECTED — Cross-tenant: conv.tenant=${conversation.tenantId}, job.tenant=${data.tenantId}`,
      );
      throw new Error(
        `Cross-tenant bot job rejected for conversation ${data.conversationId}`,
      );
    }

    const bot = conversation.bot;
    this.logger.log(
      `[BOT-PROCESSOR] Conversation state: status=${conversation.status}, ` +
        `bot=${JSON.stringify(bot ?? null)}`,
    );

    const isDone =
      conversation.status === 'resolved' ||
      conversation.status === 'closed' ||
      bot?.status === 'handoff' ||
      bot?.status === 'ended';

    if (!bot?.enabled || isDone) {
      this.logger.log(
        `[BOT-PROCESSOR] ✗ SKIP — bot.enabled=${bot?.enabled}, isDone=${isDone} ` +
          `(conv.status=${conversation.status}, bot.status=${bot?.status}), job=${job.id}`,
      );
      return;
    }

    // 2. Audit trail
    this.cls.set('executionSource', 'B');
    this.cls.set('sourceContext', { botProvider: bot.provider || 'typebot' });

    // 3. Fire-and-forget to crm-bot
    try {
      const callbackUrl = this.botApi.resolveCallbackUrl();
      this.logger.log(
        `[BOT-PROCESSOR] Dispatching to crm-bot — conv=${data.conversationId}, ` +
          `sessionId=${bot.sessionId}, callbackUrl=${callbackUrl}`,
      );

      const result = await this.botApi.dispatch({
        org: data.org,
        channelId: data.channelId,
        conversationId: data.conversationId,
        sessionId: bot.sessionId,
        inboundMessageId: data.messageId,
        text: data.text,
        channel: data.channel,
        callbackUrl,
        replyId: data.replyId,
        messageType: data.messageType,
      });

      if (result.duplicate) {
        this.logger.log(
          `[BOT-PROCESSOR] Bot reported DUPLICATE for msg=${data.messageId} — skipping`,
        );
        return;
      }

      this.logger.log(
        `[BOT-PROCESSOR] ✓ Bot ACCEPTED request for conv=${data.conversationId}, msg=${data.messageId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[BOT-PROCESSOR] ✗ Bot dispatch FAILED for conv=${data.conversationId}: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.conversationRepo.updateBotState(data.conversationId, {
        lastError: message,
      });
      throw error;
    }
  }
}
