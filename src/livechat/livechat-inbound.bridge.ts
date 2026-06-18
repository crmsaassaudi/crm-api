import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * LivechatInboundBridge — listens to `livechat.message.inbound` events
 * from LivechatGateway and routes them into the OmniInbound pipeline
 * by emitting `omni.inbound.webhook` with a livechat-normalized payload.
 *
 * This keeps LivechatGateway decoupled from OmniInboundModule.
 */
@Injectable()
export class LivechatInboundBridge {
  private readonly logger = new Logger(LivechatInboundBridge.name);

  constructor(private readonly eventEmitter: EventEmitter2) {}

  @OnEvent('livechat.message.inbound')
  handleInbound(payload: {
    visitorId: string;
    tenantId: string;
    channelId: string;
    text: string;
    timestamp: string;
    visitorName: string;
  }) {
    this.logger.debug(`Livechat inbound from visitor ${payload.visitorId}`);

    // Emit into OmniInbound pipeline
    // The webhook-processor picks this up and calls LivechatAdapter.normalize()
    this.eventEmitter.emit('omni.inbound.webhook', {
      channelType: 'livechat',
      channelId: payload.channelId,
      tenantId: payload.tenantId,
      rawPayload: {
        visitorId: payload.visitorId,
        visitorName: payload.visitorName,
        text: payload.text,
        timestamp: payload.timestamp,
      },
    });
  }
}
