import { Injectable, Inject, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'crypto';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import {
  ChannelAdapter,
  CHANNEL_ADAPTERS,
} from '../adapters/channel-adapter.interface';
import { OmniPayload, ChannelType } from '../domain/omni-payload';
import { OmniEvents, LivechatEvents } from '../domain/omni-events';
import { MetricsService } from '../../observability/metrics.service';
import {
  OMNI_ROUTING_QUEUE,
  PRIORITY_NORMAL,
} from '../queue/omni-queue.constants';

/** Livechat enqueue retries — short, because a visitor is waiting on the reply. */
const LIVECHAT_ENQUEUE_ATTEMPTS = 3;
const LIVECHAT_ENQUEUE_BACKOFF_MS = 200;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
    private readonly metrics: MetricsService,
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
  ): Promise<OmniPayload[]> {
    const adapter = this.adapters.get(channelType);
    if (!adapter) {
      throw new Error(`No adapter registered for channel type: ${channelType}`);
    }

    const messages = adapter.normalize(
      rawPayload,
      tenantId,
      channelId,
      channelConfig,
    );

    if (messages.length === 0) {
      this.handleNonMessageEvent(
        channelType,
        rawPayload,
        tenantId,
        channelId,
        channelConfig,
      );
      return [];
    }

    for (const message of messages) {
      // Stamp a correlationId at the entry point if the adapter didn't
      // supply one. It propagates through every downstream event and enables
      // end-to-end log tracing without distributed tracing infra.
      message.correlationId ??= randomUUID();
      await this.enqueueForRouting(message);
    }

    this.logger.debug(
      `Normalised ${messages.length} ${channelType} message(s) for tenant ${tenantId}`,
    );
    return messages;
  }

  private async enqueueForRouting(message: OmniPayload): Promise<void> {
    await this.routingQueue.add('omni.route', message, {
      jobId: this.buildRoutingJobId(message),
      priority: PRIORITY_NORMAL,
      removeOnComplete: { count: 500 },
      // Age-bounded, and NOT `false`: a job id that lingers in the failed set
      // makes `add()` a silent no-op, so a provider redelivery of a message
      // whose first attempt failed would never be re-queued.
      removeOnFail: { count: 2000, age: 60 * 60 * 24 },
    });
  }

  /**
   * An event with no messages is still meaningful: it may be a reaction or a
   * delivery receipt for something we sent.
   */
  private handleNonMessageEvent(
    channelType: ChannelType,
    rawPayload: any,
    tenantId: string,
    channelId: string,
    channelConfig?: any,
  ): void {
    if (
      this.processReaction(
        channelType,
        rawPayload,
        tenantId,
        channelId,
        channelConfig,
      )
    ) {
      this.logger.debug(`Processed ${channelType} reaction event`);
      return;
    }

    const receipts =
      this.adapters.get(channelType)?.normalizeDeliveryReceipts?.(rawPayload) ??
      [];
    if (receipts.length > 0) {
      this.eventEmitter.emit(OmniEvents.DELIVERY_RECEIPTS_RECEIVED, {
        tenantId,
        channelType,
        receipts,
      });
      return;
    }

    this.logger.debug(`Skipping non-message ${channelType} event`);
  }

  /**
   * Livechat inbound bridge.
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

    // Livechat has no provider to redeliver: the visitor's browser is the only
    // other copy of this message. A Redis blip on the routing enqueue used to
    // lose it silently, so retry briefly, and if it still fails, say so —
    // to the operator as a counter, and to the widget so the visitor sees the
    // message did not go through instead of waiting for a reply that cannot come.
    for (let attempt = 1; attempt <= LIVECHAT_ENQUEUE_ATTEMPTS; attempt++) {
      try {
        await this.process(
          data.channelType,
          data.rawPayload,
          data.tenantId,
          data.channelId,
          // channelConfig not required — LivechatAdapter ignores it
        );
        return;
      } catch (error: any) {
        const message = error?.message ?? String(error);
        if (attempt < LIVECHAT_ENQUEUE_ATTEMPTS) {
          this.logger.warn(
            `[livechat] Inbound enqueue attempt ${attempt} failed: ${message} — retrying`,
          );
          await delay(LIVECHAT_ENQUEUE_BACKOFF_MS * attempt);
          continue;
        }

        this.logger.error(
          `[livechat] Dropped inbound message from visitor ` +
            `${data.rawPayload?.visitorId} after ${attempt} attempts: ${message}`,
        );
        this.metrics.incrementCounter('crm_omni_messages_dropped_total', {
          channel: 'livechat',
          reason: 'enqueue_failed',
        });
        this.eventEmitter.emit(LivechatEvents.MESSAGE_REJECTED, {
          tenantId: data.tenantId,
          channelId: data.channelId,
          visitorId: data.rawPayload?.visitorId,
          clientMessageId: data.rawPayload?.metadata?.clientMessageId ?? null,
          reason: 'enqueue_failed',
        });
      }
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
    secret?: string,
  ): boolean {
    const adapter = this.adapters.get(channelType);
    if (!adapter) return false;
    return adapter.validateWebhook(headers, body, rawBody, secret);
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
