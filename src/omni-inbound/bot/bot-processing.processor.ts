import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseConsumer } from '../../queue/base.consumer';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import { OutboundService } from '../../omni-outbound/outbound.service';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { BOT_PROCESSING_QUEUE } from '../queue/bot-processing-queue.constants';
import { BotApiService } from './bot-api.service';
import { BotConversationLockService } from './bot-conversation-lock.service';
import { BotProcessingJobData, BotReplyMessage } from './bot-processing.types';

const BOT_LOCK_TTL_MS = 10_000;

class BotConversationLockBusyError extends Error {
  constructor(conversationId: string) {
    super(`Bot conversation ${conversationId} is locked by another worker`);
  }
}

@Processor(BOT_PROCESSING_QUEUE)
export class BotProcessingProcessor extends BaseConsumer {
  protected readonly logger = new Logger(BotProcessingProcessor.name);

  constructor(
    private readonly cls: ClsService,
    private readonly conversationRepo: ConversationRepository,
    private readonly messageRepo: MessageRepository,
    private readonly botApi: BotApiService,
    private readonly botLock: BotConversationLockService,
    private readonly outboundService: OutboundService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super();
  }

  async process(job: Job<BotProcessingJobData>): Promise<void> {
    const { tenantId } = job.data;
    return runWithTenantContext(this.cls, tenantId, async () =>
      this.processWithTenant(job),
    );
  }

  private async processWithTenant(
    job: Job<BotProcessingJobData>,
  ): Promise<void> {
    const { conversationId } = job.data;
    const lockKey = `lock:bot_conversation:${conversationId}`;
    const lockToken = await this.botLock.tryAcquire(lockKey, BOT_LOCK_TTL_MS);

    if (!lockToken) {
      throw new BotConversationLockBusyError(conversationId);
    }

    let lockedAtTracked = false;
    try {
      await this.handleBotReply(job.data, () => {
        lockedAtTracked = true;
      });
    } finally {
      if (lockedAtTracked) {
        await this.conversationRepo.updateBotState(conversationId, {
          lockedAt: null,
        });
      }
      await this.botLock.release(lockKey, lockToken);
    }
  }

  private async handleBotReply(
    data: BotProcessingJobData,
    trackLockedAt: () => void,
  ): Promise<void> {
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

    if (!bot.flowId) {
      await this.conversationRepo.updateBotState(data.conversationId, {
        lastError: 'Bot flowId is missing',
      });
      this.logger.warn(`Bot flowId is missing for ${data.conversationId}`);
      return;
    }

    try {
      await this.conversationRepo.updateBotState(data.conversationId, {
        lockedAt: new Date(),
      });
      trackLockedAt();

      const response = await this.botApi.reply({
        org: data.org,
        conversationId: data.conversationId,
        flowId: bot.flowId,
        sessionId: bot.sessionId,
        inboundMessageId: data.messageId,
        text: data.text,
        channel: data.channel,
      });

      if (response.sessionId && response.sessionId !== bot.sessionId) {
        await this.conversationRepo.updateBotState(data.conversationId, {
          sessionId: response.sessionId,
          status: response.status ?? 'active',
          lastError: null,
        });
      } else if (response.status) {
        await this.conversationRepo.updateBotState(data.conversationId, {
          status: response.status,
          lastError: null,
        });
      } else {
        await this.conversationRepo.updateBotState(data.conversationId, {
          lastError: null,
        });
      }

      for (const [index, message] of (response.messages ?? []).entries()) {
        await this.sendBotMessage(data, message, index);
      }

      if (response.handoff || response.status === 'handoff') {
        await this.handleHandoff(data);
      } else if (response.status === 'ended') {
        await this.conversationRepo.updateBotState(data.conversationId, {
          enabled: false,
          status: 'ended',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.conversationRepo.updateBotState(data.conversationId, {
        lastError: message,
      });
      throw error;
    }
  }

  private async sendBotMessage(
    data: BotProcessingJobData,
    message: BotReplyMessage,
    index: number,
  ): Promise<void> {
    const content = message.text?.trim();
    if (!content) return;

    await this.outboundService.sendBotMessage({
      tenantId: data.tenantId,
      conversationId: data.conversationId,
      content,
      messageType: 'text',
      buttons: message.buttons,
      idempotencyKey: `bot:${data.messageId}:${index}`,
    });
  }

  private async handleHandoff(data: BotProcessingJobData): Promise<void> {
    await this.conversationRepo.markBotHandoff(data.conversationId);

    const systemMessage = await this.messageRepo.create({
      tenantId: data.tenantId,
      conversationId: data.conversationId,
      senderId: 'system',
      senderName: 'System',
      senderType: 'system',
      direction: 'internal',
      source: 'bot',
      messageType: 'text',
      content: '\u0110ang chuy\u1ec3n t\u01b0 v\u1ea5n vi\u00ean',
      status: 'delivered',
      metadata: {
        event: 'bot_handoff',
        provider: 'typebot',
      },
    });

    await this.conversationRepo.updateLastMessage(
      data.conversationId,
      systemMessage.content,
      new Date(),
      'system',
    );

    this.eventEmitter.emit('omni.message.sent', {
      tenantId: data.tenantId,
      conversationId: data.conversationId,
      senderId: 'system',
      senderName: 'System',
      senderType: 'system',
      direction: 'internal',
      source: 'bot',
      messageType: 'text',
      content: systemMessage.content,
      messageId: systemMessage.id,
      status: 'delivered',
      timestamp: new Date().toISOString(),
      transport: 'http',
      metadata: systemMessage.metadata,
    });
  }
}
