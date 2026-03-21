import { Injectable, Inject, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ChannelAdapter, CHANNEL_ADAPTERS } from '../adapters/channel-adapter.interface';
import { OmniPayload, ChannelType } from '../domain/omni-payload';

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
  ): Promise<OmniPayload> {
    const adapter = this.adapters.get(channelType);
    if (!adapter) {
      throw new Error(`No adapter registered for channel type: ${channelType}`);
    }

    const normalized = adapter.normalize(rawPayload, tenantId, channelId);

    this.logger.log(
      `Processed ${channelType} message: ${normalized.externalMessageId} ` +
        `from sender ${normalized.senderId}`,
    );

    // Fire-and-forget domain event — listeners handle persistence & realtime
    this.eventEmitter.emit('omni.message.received', normalized);

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
}
