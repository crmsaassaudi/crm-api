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
import {
  TicketSchemaClass,
  TicketSchemaDocument,
} from '../../tickets/infrastructure/persistence/document/entities/ticket.schema';
import type { SlaSubjectType } from '../../sla-policies/clock/sla-clock.schema';

export interface EscalationJobData extends TenantJobData {
  subjectType: SlaSubjectType;
  subjectId: string;
  escalationPolicyId: string;
  /** The escalation level: 'warning' = red highlight, 'breach' = notify manager */
  level: 'warning' | 'breach';
  actions: Array<{ type: string; value: string }>;
}

/**
 * Executes an escalation once its delay has elapsed, for conversations and
 * tickets alike.
 *
 * Actions:
 *   - color_red/escalate: mark the subject for a red highlight
 *   - notify: mark it critical and ping the named manager
 *   - reassign: hand the work to the named user
 */
@Processor(ESCALATION_QUEUE)
export class EscalationProcessor extends BaseTenantConsumer<EscalationJobData> {
  protected readonly logger = new Logger(EscalationProcessor.name);
  protected readonly cls: ClsService;

  constructor(
    @InjectModel(OmniConversationSchemaClass.name)
    private readonly conversationModel: Model<OmniConversationDocument>,
    @InjectModel(TicketSchemaClass.name)
    private readonly ticketModel: Model<TicketSchemaDocument>,
    private readonly eventEmitter: EventEmitter2,
    private readonly commands: ConversationCommandService,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    cls: ClsService,
  ) {
    super();
    this.cls = cls;
  }

  protected async handle(job: Job<EscalationJobData>): Promise<void> {
    const {
      tenantId,
      subjectType,
      subjectId,
      escalationPolicyId,
      level,
      actions,
    } = job.data;

    this.logger.debug(
      `Processing escalation [${level}] for ${subjectType} ${subjectId}`,
    );

    if (subjectType === 'ticket') {
      await this.escalateTicket(job.data);
      return;
    }

    // Verify conversation is still active
    const conversation = await this.conversationModel
      .findOne({
        _id: subjectId,
        tenantId,
        status: { $in: ['open', 'pending'] },
      })
      .lean()
      .exec();

    if (!conversation) {
      this.logger.debug(
        `Conversation ${subjectId} no longer active — skipping escalation`,
      );
      return;
    }

    const now = new Date();

    for (const action of actions) {
      switch (action.type) {
        case 'color_red':
        case 'escalate': {
          await this.conversationModel.updateOne(
            { _id: subjectId },
            { $set: { escalationLevel: 'warning', escalatedAt: now } },
          );

          this.eventEmitter.emit('omni.conversation.escalated', {
            tenantId,
            conversationId: subjectId,
            escalationLevel: 'warning',
            escalationPolicyId,
            escalatedAt: now,
          });

          this.logger.warn(
            `Conversation ${subjectId} escalated to WARNING (red highlight)`,
          );
          break;
        }

        case 'notify': {
          await this.conversationModel.updateOne(
            { _id: subjectId },
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
            conversationId: subjectId,
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
              conversationId: subjectId,
              targetUserId: action.value,
              message:
                'SLA breached for conversation — your attention is needed',
              escalationPolicyId,
            }),
          );

          this.logger.warn(
            `Conversation ${subjectId} escalated to CRITICAL — notified ${action.value}`,
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

          await this.commands.enqueueAssignAgent(subjectId, tenantId, {
            agentId: action.value,
            reason: 'escalation',
            syncCapacity: { assignAgentId: action.value },
            auditLog: { channelType: conversation.channelType },
          });

          this.logger.warn(
            `Conversation ${subjectId} reassigned to ${action.value} via escalation`,
          );
          break;
        }

        default:
          this.logger.warn(`Unknown escalation action type: ${action.type}`);
      }
    }
  }

  /**
   * The ticket branch.
   *
   * Reassignment writes `ownerId` directly rather than going through the
   * assignment engine: an escalation names the person deliberately, and the
   * engine's claim-only compare-and-set exists to refuse exactly that — taking
   * a record from its current owner.
   */
  private async escalateTicket(data: EscalationJobData): Promise<void> {
    const { tenantId, subjectId, escalationPolicyId, actions } = data;

    const ticket = await this.ticketModel
      .findOne({ _id: subjectId, tenantId, deletedAt: null, closedAt: null })
      .select({ _id: 1, ticketNumber: 1, ownerId: 1 })
      .lean()
      .exec();
    if (!ticket) {
      this.logger.debug(
        `Ticket ${subjectId} closed or gone — skipping escalation`,
      );
      return;
    }

    const now = new Date();

    for (const action of actions) {
      switch (action.type) {
        case 'color_red':
        case 'escalate':
          await this.ticketModel.updateOne(
            { _id: subjectId, tenantId },
            { $set: { escalationLevel: 'warning', escalatedAt: now } },
          );
          this.logger.warn(
            `Ticket ${ticket.ticketNumber} escalated to WARNING`,
          );
          break;

        case 'notify': {
          if (!action.value) {
            this.logger.error(
              `Escalation policy ${escalationPolicyId} has a notify action with no target — skipping`,
            );
            break;
          }
          await this.ticketModel.updateOne(
            { _id: subjectId, tenantId },
            {
              $set: {
                escalationLevel: 'critical',
                escalatedToId: action.value,
                escalatedAt: now,
              },
            },
          );
          await this.redis.publish(
            'socket:ticket:escalation:notify',
            JSON.stringify({
              tenantId,
              ticketId: subjectId,
              ticketNumber: ticket.ticketNumber,
              targetUserId: action.value,
              message: `SLA breached on ticket ${ticket.ticketNumber} — your attention is needed`,
              escalationPolicyId,
            }),
          );
          this.logger.warn(
            `Ticket ${ticket.ticketNumber} escalated to CRITICAL — notified ${action.value}`,
          );
          break;
        }

        case 'reassign': {
          if (!action.value) {
            this.logger.error(
              `Escalation policy ${escalationPolicyId} has a reassign action with no target — skipping`,
            );
            break;
          }
          await this.ticketModel.updateOne(
            { _id: subjectId, tenantId },
            {
              $set: {
                ownerId: action.value,
                ownerAssignedExplicitly: true,
                escalationLevel: 'critical',
                escalatedToId: action.value,
                escalatedAt: now,
              },
            },
          );
          this.logger.warn(
            `Ticket ${ticket.ticketNumber} reassigned to ${action.value} via escalation`,
          );
          break;
        }

        default:
          this.logger.warn(`Unknown escalation action type: ${action.type}`);
      }
    }

    this.eventEmitter.emit('ticket.escalated', {
      tenantId,
      ticketId: subjectId,
      escalationPolicyId,
      escalatedAt: now,
    });
  }
}
