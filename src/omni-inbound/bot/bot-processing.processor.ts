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

    // 1. Validate conversation state
    const conversation = await this.conversationRepo.findById(
      data.conversationId,
    );
    if (!conversation) {
      this.logger.warn(`Conversation ${data.conversationId} not found`);
      return;
    }
    if (conversation.tenantId !== data.tenantId) {
      throw new Error(
        `Cross-tenant bot job rejected for conversation ${data.conversationId}`,
      );
    }

    const bot = conversation.bot;
    const isDone =
      conversation.status === 'resolved' ||
      conversation.status === 'closed' ||
      bot?.status === 'handoff' ||
      bot?.status === 'ended';

    if (!bot?.enabled || isDone) {
      this.logger.debug(
        `Skipping bot job for conversation ${data.conversationId}: bot disabled or done`,
      );
      return;
    }

    // 2. Audit trail
    this.cls.set('executionSource', 'B');
    this.cls.set('sourceContext', { botProvider: bot.provider || 'typebot' });

    // 3. Fire-and-forget to crm-bot
    try {
      const callbackUrl = this.botApi.resolveCallbackUrl();

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
        this.logger.debug(
          `Bot reported duplicate for message ${data.messageId} — skipping`,
        );
        return;
      }

      this.logger.debug(
        `Bot accepted request for conversation ${data.conversationId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.conversationRepo.updateBotState(data.conversationId, {
        lastError: message,
      });
      throw error;
    }
  }
}
