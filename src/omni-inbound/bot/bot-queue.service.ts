import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { BOT_PROCESSING_QUEUE } from '../queue/bot-processing-queue.constants';
import { BotProcessingJobData } from './bot-processing.types';

@Injectable()
export class BotQueueService {
  private readonly logger = new Logger(BotQueueService.name);

  constructor(
    @InjectQueue(BOT_PROCESSING_QUEUE)
    private readonly botQueue: Queue<BotProcessingJobData>,
  ) {}

  async enqueueInboundMessage(data: BotProcessingJobData): Promise<void> {
    this.logger.log(
      `[BOT-QUEUE] Received enqueue request — conv=${data.conversationId}, msg=${data.messageId}, ` +
        `channel=${data.channel}, text="${(data.text || '').substring(0, 50)}", messageType=${data.messageType}`,
    );

    // Media messages may have empty text (caption) — allow them through
    const hasContent =
      data.text?.trim() || (data.messageType && data.messageType !== 'text');
    if (!hasContent) {
      this.logger.log(
        `[BOT-QUEUE] ✗ SKIP — empty content for msg=${data.messageId}, text="${data.text}", messageType=${data.messageType}`,
      );
      return;
    }

    const jobId = `bot-${data.tenantId}-${data.messageId}`;
    await this.botQueue.add('process-bot-message', data, { jobId });
    this.logger.log(
      `[BOT-QUEUE] ✓ Job ADDED — jobId=${jobId}, conv=${data.conversationId}`,
    );
  }
}
