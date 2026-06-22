import { Injectable, Inject, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash } from 'crypto';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import {
  ChannelAdapter,
  CHANNEL_ADAPTERS,
} from '../adapters/channel-adapter.interface';
import { OmniPayload, ChannelType } from '../domain/omni-payload';
import { OmniEvents } from '../domain/omni-events';
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
 * 3. Push normalized payload to OMNI_ROUTING_QUEUE for async processing.
 *
 * Also listens for the `omni.inbound.webhook` EventEmitter event emitted
 * by LivechatInboundBridge (F1 fix — bridges WS-based livechat into this pipeline).
 */
@Injectable()
export class InboundProcessorService {
  private readonly logger = new Logger(InboundProcessorService.name);

  constructor(
    @Inject(CHANNEL_ADAPTERS)
    private readonly adapters: Map<ChannelType, ChannelAdapter>,
    @InjectQueue(OMNI_ROUTING_QUEUE)
    private readonly routingQueue: Queue<OmniPayload>,
    private readonly eventEmitter: EventEmitter2,
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
      // Try as a reaction event before discarding
      const handled = await this.processReaction(
        channelType,
        rawPayload,
        tenantId,
        channelId,
        channelConfig,
      );
      if (handled) {
        this.logger.debug(`Processed ${channelType} reaction event`);
        return null;
      }

      this.logger.debug(
        `Skipping non-message ${channelType} event (delivery/read/referral)`,
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
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 2000 },
    });

    return normalized;
  }

  /**
   * F1 Fix — Livechat inbound bridge.
   *
   * LivechatInboundBridge emits `omni.inbound.webhook` via EventEmitter2.
   * This handler receives it and routes it through the same normalize → queue
   * pipeline used by all other channel types.
   *
   * Note: channelConfig is optional for livechat (LivechatAdapter ignores it).
   */
  @OnEvent(OmniEvents.INBOUND_WEBHOOK)
  async handleLivechatInboundEvent(data: {
    channelType: ChannelType;
    channelId: string;
    tenantId: string;
    rawPayload: any;
  }): Promise<void> {
    this.logger.debug(
      `[livechat] omni.inbound.webhook received — channelId=${data.channelId}, tenant=${data.tenantId}`,
    );
    try {
      await this.process(
        data.channelType,
        data.rawPayload,
        data.tenantId,
        data.channelId,
        // channelConfig not required — LivechatAdapter ignores it
      );
    } catch (error: any) {
      this.logger.error(
        `[livechat] Failed to process inbound event: ${error?.message ?? String(error)}`,
      );
    }
  }

  /**
   * Validate a webhook request before processing.
   */
  validateWebhook(
    channelType: ChannelType,
    headers: Record<string, string>,
    body: any,
    rawBody?: Buffer,
  ): boolean {
    const adapter = this.adapters.get(channelType);
    if (!adapter) return false;
    return adapter.validateWebhook(headers, body, rawBody);
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

  /**
   * Attempt to process a raw webhook payload as a reaction event.
   * Returns true if the payload was a valid reaction and was emitted.
   */
  processReaction(
    channelType: ChannelType,
    rawPayload: any,
    tenantId: string,
    channelId: string,
    channelConfig?: any,
  ): boolean {
    const adapter = this.adapters.get(channelType);
    if (!adapter?.normalizeReaction) return false;

    const reaction = adapter.normalizeReaction(
      rawPayload,
      tenantId,
      channelId,
      channelConfig,
    );
    if (!reaction) return false;

    // Emit unified event → ReactionService picks it up
    this.eventEmitter.emit(OmniEvents.REACTION_INBOUND, reaction);
    return true;
  }
}
