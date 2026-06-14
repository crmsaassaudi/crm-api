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
    // Media messages may have empty text (caption) — allow them through
    const hasContent =
      data.text?.trim() || (data.messageType && data.messageType !== 'text');
    if (!hasContent) {
      this.logger.debug(
        `Skipping bot queue for empty inbound message ${data.messageId}`,
      );
      return;
    }

    await this.botQueue.add('process-bot-message', data, {
      jobId: `bot-${data.tenantId}-${data.messageId}`,
    });
  }
}
