import { Injectable, Inject, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash } from 'crypto';
import {
  ChannelAdapter,
  CHANNEL_ADAPTERS,
} from '../adapters/channel-adapter.interface';
import { OmniPayload, ChannelType } from '../domain/omni-payload';
import {
  OMNI_ROUTING_QUEUE,
  PRIORITY_NORMAL,
} from '../queue/omni-queue.constants';

/**
 * Single entry-point for all inbound messages from any provider.
 *
 * Responsibilities:
 * 1. Resolve the correct adapter for the channel type
 * 2. Normalize the raw payload into OmniPayload
 * 3. Emit a domain event so listeners (persistence, realtime gateway, etc.)
 *    can react — no if-else anywhere downstream.
 */
@Injectable()
export class InboundProcessorService {
  private readonly logger = new Logger(InboundProcessorService.name);

  constructor(
    @Inject(CHANNEL_ADAPTERS)
    private readonly adapters: Map<ChannelType, ChannelAdapter>,
    @InjectQueue(OMNI_ROUTING_QUEUE)
    private readonly routingQueue: Queue<OmniPayload>,
  ) {}

  /**
   * Process a raw inbound webhook payload.
   *
   * @param channelType  Which provider sent this
   * @param rawPayload   The raw JSON body (per-event, not the batch wrapper)
   * @param tenantId     Resolved tenant
   * @param channelId    Our internal Channel document ID
   */
  async process(
    channelType: ChannelType,
    rawPayload: any,
    tenantId: string,
    channelId: string,
    channelConfig?: any,
  ): Promise<OmniPayload | null> {
    const adapter = this.adapters.get(channelType);
    if (!adapter) {
      throw new Error(`No adapter registered for channel type: ${channelType}`);
    }

    const normalized = adapter.normalize(
      rawPayload,
      tenantId,
      channelId,
      channelConfig,
    );

    // Adapter returns null for non-message events (delivery receipts, read receipts, etc.)
    if (normalized === null) {
      this.logger.debug(
        `Skipping non-message ${channelType} event (delivery/read/reaction/referral)`,
      );
      return null;
    }

    this.logger.log(
      `Processed ${channelType} message: ${normalized.externalMessageId} ` +
        `from sender ${normalized.senderId}`,
    );

    await this.routingQueue.add('omni.route', normalized, {
      jobId: this.buildRoutingJobId(normalized),
      priority: PRIORITY_NORMAL,
    });

    return normalized;
  }

  /**
   * Validate a webhook request before processing.
   */
  validateWebhook(
    channelType: ChannelType,
    headers: Record<string, string>,
    body: any,
  ): boolean {
    const adapter = this.adapters.get(channelType);
    if (!adapter) return false;
    return adapter.validateWebhook(headers, body);
  }

  private buildRoutingJobId(payload: OmniPayload): string {
    return createHash('sha256')
      .update(
        [
          payload.tenantId,
          payload.channelType,
          payload.channelAccount,
          payload.externalMessageId,
        ]
          .map((part) => String(part || 'unknown'))
          .join('|'),
      )
      .digest('hex');
  }
}
