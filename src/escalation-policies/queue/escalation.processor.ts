import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Inject, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import type Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { ConversationCommandService } from '../../omni-inbound/aggregate/conversation-command.service';
import {
  BaseTenantConsumer,
  TenantJobData,
} from '../../queue/base-tenant.consumer';
import { ESCALATION_QUEUE } from './escalation-queue.constants';
import {
  OmniConversationSchemaClass,
  OmniConversationDocument,
} from '../../omni-inbound/infrastructure/persistence/document/entities/omni-conversation.schema';

export interface EscalationJobData extends TenantJobData {
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
export class EscalationProcessor extends BaseTenantConsumer<EscalationJobData> {
  protected readonly logger = new Logger(EscalationProcessor.name);
  protected readonly cls: ClsService;

  constructor(
    @InjectModel(OmniConversationSchemaClass.name)
    private readonly conversationModel: Model<OmniConversationDocument>,
    private readonly eventEmitter: EventEmitter2,
    private readonly commands: ConversationCommandService,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    cls: ClsService,
  ) {
    super();
    this.cls = cls;
  }

  protected async handle(job: Job<EscalationJobData>): Promise<void> {
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

    // Process each action
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

          // Publish on the Redis channel `CrmRealtimeGateway` bridges into
          // Socket.IO. The previous `omni.escalation.notify` in-process event had
          // no listener at all, and could not have worked anyway: this processor
          // runs in the worker, which holds no sockets.
          await this.redis.publish(
            'socket:omni:escalation:notify',
            JSON.stringify({
              tenantId,
              conversationId,
              targetUserId: action.value,
              message:
                'SLA breached for conversation — your attention is needed',
              escalationPolicyId,
            }),
          );

          this.logger.warn(
            `Conversation ${conversationId} escalated to CRITICAL — notified ${action.value}`,
          );
          break;
        }

        case 'reassign': {
          // Actually reassign. This used to emit `omni.escalation.reassign` — an
          // event with no listener anywhere — and then log that the conversation
          // had been reassigned. An escalation policy configured to hand work to
          // a team lead did nothing at all, while reporting success.
          //
          // Routed through ConversationCommandService rather than a direct
          // `updateOne` so the move is serialised with every other conversation
          // mutation, moves the agent's capacity, and lands in the assignment
          // audit trail like any other reassignment.
          if (!action.value) {
            this.logger.error(
              `Escalation policy ${escalationPolicyId} has a reassign action with no target — skipping`,
            );
            break;
          }

          await this.commands.enqueueAssignAgent(conversationId, tenantId, {
            agentId: action.value,
            reason: 'escalation',
            syncCapacity: { assignAgentId: action.value },
            auditLog: { channelType: conversation.channelType },
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
