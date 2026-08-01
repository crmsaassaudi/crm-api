import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { OmniEvents } from '../domain/omni-events';
import {
  DeliveryReceipt,
  isStatusProgression,
} from '../domain/delivery-receipt';
import { MessageRepository } from '../repositories/message.repository';

interface DeliveryReceiptsEvent {
  tenantId: string;
  channelType: string;
  receipts: DeliveryReceipt[];
}

/**
 * Applies provider delivery/read receipts to the messages we sent.
 *
 * Without this an outbound message never leaves `sent`: the only other writer
 * is the reconciliation cron, which can just mark it failed on a timeout. The
 * "delivered" and "read" ticks an agent expects to see had no source.
 */
@Injectable()
export class DeliveryReceiptService {
  private readonly logger = new Logger(DeliveryReceiptService.name);

  constructor(
    private readonly messageRepo: MessageRepository,
    private readonly events: EventEmitter2,
  ) {}

  @OnEvent(OmniEvents.DELIVERY_RECEIPTS_RECEIVED)
  async handleReceipts(event: DeliveryReceiptsEvent): Promise<void> {
    for (const receipt of event.receipts) {
      try {
        await this.apply(event.tenantId, receipt);
      } catch (err: any) {
        // One bad receipt must not drop the rest of the batch.
        this.logger.warn(
          `Failed to apply ${receipt.status} receipt for ${receipt.externalMessageId}: ${err?.message}`,
        );
      }
    }
  }

  private async apply(
    tenantId: string,
    receipt: DeliveryReceipt,
  ): Promise<void> {
    const message = await this.messageRepo.findByExternalId(
      tenantId,
      receipt.externalMessageId,
    );
    // Receipts for messages we never stored (sent outside the CRM, or already
    // purged) are not an error — there is simply nothing to update.
    if (!message) return;

    // Providers do not guarantee receipt order, and a `delivered` arriving
    // after a `read` must not walk the status backwards.
    if (!isStatusProgression(message.status, receipt.status)) return;

    await this.messageRepo.applyDeliveryReceipt(message.id, receipt);

    this.events.emit('livechat.message.status', {
      tenantId,
      conversationId: message.conversationId,
      messageIds: [message.id],
      status: receipt.status,
    });
  }
}
