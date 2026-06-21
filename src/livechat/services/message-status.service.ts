import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  OmniMessageSchemaClass,
  OmniMessageDocument,
} from '../../omni-inbound/infrastructure/persistence/document/entities/omni-message.schema';

/**
 * Status progression weight — status can only advance forward, never rollback.
 *
 *   sending (0) → sent (1) → delivered (2) → read (3)
 *   failed (-1) — terminal state
 */
const STATUS_WEIGHT: Record<string, number> = {
  failed: -1,
  sending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

/** Maximum message IDs per batch to prevent abuse */
const MAX_BATCH_SIZE = 50;

/**
 * MessageStatusService — handles delivery receipt (delivered/read) logic
 * for the livechat channel.
 *
 * Flow:
 *   visitor:ack   → markDelivered() → emits 'livechat.message.status'
 *   visitor:read  → markRead()      → emits 'livechat.message.status'
 *
 * The emitted events are consumed by:
 *   - OmniGateway    → broadcasts 'omni:message:status' to agent CRM
 *   - LivechatGateway → broadcasts 'message:status' to visitor widget
 */
@Injectable()
export class MessageStatusService {
  private readonly logger = new Logger(MessageStatusService.name);

  constructor(
    @InjectModel(OmniMessageSchemaClass.name)
    private readonly messageModel: Model<OmniMessageDocument>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Mark messages as 'delivered' — called when visitor widget acknowledges
   * receipt of agent messages.
   *
   * Only advances status: sent → delivered (skips already delivered/read).
   */
  async markDelivered(
    tenantId: string,
    messageIds: string[],
  ): Promise<string[]> {
    return this.advanceStatus(tenantId, messageIds, 'delivered');
  }

  /**
   * Mark messages as 'read' — called when visitor scrolls agent messages
   * into viewport (IntersectionObserver).
   *
   * Only advances status: sent/delivered → read (skips already read).
   */
  async markRead(tenantId: string, messageIds: string[]): Promise<string[]> {
    return this.advanceStatus(tenantId, messageIds, 'read');
  }

  /**
   * Core status advancement logic.
   *
   * 1. Caps batch at MAX_BATCH_SIZE
   * 2. Fetches current status of all target messages
   * 3. Filters to only those that would actually advance
   * 4. Bulk-writes the update
   * 5. Emits 'livechat.message.status' per message for downstream consumers
   *
   * @returns Array of messageIds that were actually updated
   */
  private async advanceStatus(
    tenantId: string,
    rawMessageIds: string[],
    targetStatus: 'delivered' | 'read',
  ): Promise<string[]> {
    const messageIds = rawMessageIds.slice(0, MAX_BATCH_SIZE);
    if (messageIds.length === 0) return [];

    const targetWeight = STATUS_WEIGHT[targetStatus];

    // Fetch current status for all candidate messages
    const docs = await this.messageModel
      .find(
        { _id: { $in: messageIds }, tenantId },
        { _id: 1, status: 1, conversationId: 1 },
      )
      .lean()
      .exec();

    // Filter: only advance forward (e.g. sent → delivered, delivered → read)
    const toUpdate = docs.filter((doc) => {
      const currentWeight = STATUS_WEIGHT[doc.status] ?? 0;
      return currentWeight < targetWeight && currentWeight >= 0; // skip failed
    });

    if (toUpdate.length === 0) return [];

    const idsToUpdate = toUpdate.map((d) => d._id);

    // Bulk update
    await this.messageModel.updateMany(
      { _id: { $in: idsToUpdate } },
      { $set: { status: targetStatus } },
    );

    this.logger.debug(
      `Advanced ${idsToUpdate.length} message(s) to '${targetStatus}' for tenant ${tenantId}`,
    );

    // Group by conversationId for efficient event emission
    const byConversation = new Map<string, string[]>();
    for (const doc of toUpdate) {
      const convId = doc.conversationId?.toString();
      if (!convId) continue;
      const list = byConversation.get(convId) ?? [];
      list.push(doc._id.toString());
      byConversation.set(convId, list);
    }

    // Emit events — one per conversation for batched efficiency
    for (const [conversationId, ids] of byConversation) {
      this.eventEmitter.emit('livechat.message.status', {
        tenantId,
        conversationId,
        messageIds: ids,
        status: targetStatus,
      });
    }

    return idsToUpdate.map((id) => id.toString());
  }

  /**
   * Mark all unread **inbound** (visitor → agent) messages in a conversation
   * as 'read'. Called when the agent opens/views a livechat conversation.
   *
   * Unlike `markRead()` which operates on specific messageIds from the visitor,
   * this method finds ALL eligible messages in the conversation.
   *
   * @returns Array of messageIds that were actually updated
   */
  async markReadByAgent(
    tenantId: string,
    conversationId: string,
  ): Promise<string[]> {
    // Find all inbound messages in this conversation that are not yet 'read'
    const docs = await this.messageModel
      .find(
        {
          tenantId,
          conversationId,
          direction: 'inbound',
          status: { $in: ['sent', 'delivered'] },
        },
        { _id: 1, status: 1 },
      )
      .lean()
      .exec();

    if (docs.length === 0) return [];

    const idsToUpdate = docs.map((d) => d._id);

    // Bulk update to 'read'
    await this.messageModel.updateMany(
      { _id: { $in: idsToUpdate } },
      { $set: { status: 'read' } },
    );

    const updatedStringIds = idsToUpdate.map((id) => id.toString());

    this.logger.debug(
      `Agent read: advanced ${idsToUpdate.length} inbound message(s) to 'read' ` +
        `for conversation ${conversationId}, tenant ${tenantId}`,
    );

    // FIX: Emit 'livechat.message.status' so OmniGateway can broadcast
    // 'omni:message:status' to the agent CRM UI in real-time.
    // Without this, the CRM never receives a socket event to update
    // message status when the agent marks messages as read.
    this.eventEmitter.emit('livechat.message.status', {
      tenantId,
      conversationId,
      messageIds: updatedStringIds,
      status: 'read',
    });

    return updatedStringIds;
  }
}
