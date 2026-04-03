import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  OmniConversationSchemaClass,
  OmniConversationDocument,
} from '../omni-inbound/infrastructure/persistence/document/entities/omni-conversation.schema';

/**
 * SlaMonitorService — periodic cron job that scans for conversations
 * whose SLA deadline has passed without being resolved.
 *
 * When a breach is detected:
 *  1. Mark `slaBreached = true` on the conversation.
 *  2. Emit `sla.breached` event so escalation-policies can react.
 */
@Injectable()
export class SlaMonitorService {
  private readonly logger = new Logger(SlaMonitorService.name);

  constructor(
    @InjectModel(OmniConversationSchemaClass.name)
    private readonly conversationModel: Model<OmniConversationDocument>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Runs every minute — scans for conversations where:
   *   - status is 'open' or 'pending'
   *   - slaDeadline is in the past
   *   - slaBreached is still false
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async checkSlaBreaches(): Promise<void> {
    const now = new Date();

    const breachedConversations = await this.conversationModel
      .find({
        status: { $in: ['open', 'pending'] },
        slaDeadline: { $lte: now, $ne: null },
        slaBreached: false,
      })
      .limit(100) // batch size to avoid overload
      .exec();

    if (breachedConversations.length === 0) return;

    this.logger.warn(
      `Found ${breachedConversations.length} SLA breaches to process`,
    );

    for (const conv of breachedConversations) {
      try {
        await this.conversationModel.updateOne(
          { _id: conv._id },
          { $set: { slaBreached: true } },
        );

        // Emit event for escalation-policies module to pick up
        this.eventEmitter.emit('sla.breached', {
          tenantId: conv.tenantId,
          conversationId: conv._id.toString(),
          channelType: conv.channelType,
          assignedAgentId: conv.assignedAgentId,
          slaDeadline: conv.slaDeadline,
          slaPolicyId: conv.slaPolicyId,
          breachedAt: now,
        });

        this.logger.warn(
          `SLA breached for conversation ${conv._id} ` +
            `(deadline: ${conv.slaDeadline?.toISOString()})`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to process SLA breach for ${conv._id}: ${err.message}`,
        );
      }
    }
  }
}
