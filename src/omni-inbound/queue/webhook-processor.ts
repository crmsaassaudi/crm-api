import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { BaseConsumer } from '../../queue/base.consumer';
import { InboundProcessorService } from '../processors/inbound-processor.service';
import { OMNI_WEBHOOK_QUEUE } from './omni-queue.constants';
import { ChannelType } from '../domain/omni-payload';

export interface WebhookJobData {
  channelType: ChannelType;
  event: any;
  tenantId: string;
  channelId: string;
}

/**
 * BullMQ worker that consumes webhook payloads from the queue
 * and runs them through the adapter normalization pipeline.
 *
 * Retries are handled automatically by BullMQ (3 attempts, exponential backoff).
 */
@Processor(OMNI_WEBHOOK_QUEUE)
export class WebhookProcessor extends BaseConsumer {
  protected readonly logger = new Logger(WebhookProcessor.name);

  constructor(private readonly processor: InboundProcessorService) {
    super();
  }

  async process(job: Job<WebhookJobData>): Promise<void> {
    const { channelType, event, tenantId, channelId } = job.data;

    this.logger.log(
      `Processing webhook job ${job.id} — ${channelType} for tenant ${tenantId}`,
    );

    await this.processor.process(channelType, event, tenantId, channelId);
  }
}
