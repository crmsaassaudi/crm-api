import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BaseConsumer } from '../../queue/base.consumer';
import { ESCALATION_QUEUE } from './escalation-queue.constants';
import {
  OmniConversationSchemaClass,
  OmniConversationDocument,
} from '../../omni-inbound/infrastructure/persistence/document/entities/omni-conversation.schema';

export interface EscalationJobData {
  tenantId: string;
  conversationId: string;
  escalationPolicyId: string;
  /** The escalation level: 'warning' = red highlight, 'breach' = notify manager */
  level: 'warning' | 'breach';
  actions: Array<{ type: string; value: string }>;
}

/**
 * BullMQ processor for escalation delayed jobs.
 *
 * When an SLA breach is detected, EscalationTriggerListener schedules
 * delayed jobs based on the escalation policy's `escalateAfter` duration.
 *
 * Actions:
 *   - color_red/escalate: Set escalationLevel = 'warning' on conversation
 *   - notify: Set escalationLevel = 'critical' + emit event to notify manager
 *   - reassign: Emit event to reassign conversation to manager
 */
@Processor(ESCALATION_QUEUE)
export class EscalationProcessor extends BaseConsumer {
  protected readonly logger = new Logger(EscalationProcessor.name);

  constructor(
    @InjectModel(OmniConversationSchemaClass.name)
    private readonly conversationModel: Model<OmniConversationDocument>,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super();
  }

  async process(job: Job<EscalationJobData>): Promise<void> {
    const { tenantId, conversationId, escalationPolicyId, level, actions } =
      job.data;

    this.logger.debug(
      `Processing escalation [${level}] for conversation ${conversationId}`,
    );

    // Verify conversation is still active
    const conversation = await this.conversationModel
      .findOne({
        _id: conversationId,
        tenantId,
        status: { $in: ['open', 'pending'] },
      })
      .lean()
      .exec();

    if (!conversation) {
      this.logger.debug(
        `Conversation ${conversationId} no longer active — skipping escalation`,
      );
      return;
    }

    const now = new Date();

    // ── Process each action ──────────────────────────────────────
    for (const action of actions) {
      switch (action.type) {
        case 'color_red':
        case 'escalate': {
          // Visual escalation — mark conversation for red highlight
          await this.conversationModel.updateOne(
            { _id: conversationId },
            {
              $set: {
                escalationLevel: 'warning',
                escalatedAt: now,
              },
            },
          );

          this.eventEmitter.emit('omni.conversation.escalated', {
            tenantId,
            conversationId,
            escalationLevel: 'warning',
            escalationPolicyId,
            escalatedAt: now,
          });

          this.logger.warn(
            `Conversation ${conversationId} escalated to WARNING (red highlight)`,
          );
          break;
        }

        case 'notify': {
          // Critical escalation — notify manager
          await this.conversationModel.updateOne(
            { _id: conversationId },
            {
              $set: {
                escalationLevel: 'critical',
                escalatedToId: action.value, // manager userId or group
                escalatedAt: now,
              },
            },
          );

          this.eventEmitter.emit('omni.conversation.escalated', {
            tenantId,
            conversationId,
            escalationLevel: 'critical',
            escalationPolicyId,
            notifyTarget: action.value,
            escalatedAt: now,
          });

          // Emit notification event for realtime websocket
          this.eventEmitter.emit('omni.escalation.notify', {
            tenantId,
            conversationId,
            targetUserId: action.value,
            message: `SLA breached for conversation — your attention is needed`,
            escalationPolicyId,
          });

          this.logger.warn(
            `Conversation ${conversationId} escalated to CRITICAL — notified ${action.value}`,
          );
          break;
        }

        case 'reassign': {
          // Reassign to manager/team lead
          this.eventEmitter.emit('omni.escalation.reassign', {
            tenantId,
            conversationId,
            targetUserId: action.value,
            escalationPolicyId,
          });

          this.logger.warn(
            `Conversation ${conversationId} reassigned to ${action.value} via escalation`,
          );
          break;
        }

        default:
          this.logger.warn(`Unknown escalation action type: ${action.type}`);
      }
    }
  }
}
